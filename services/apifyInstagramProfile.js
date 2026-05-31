const { ApifyClient } = require('apify-client');

const ACTOR_ID = 'apify/instagram-profile-scraper';
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

/** @type {Map<string, { raw: object|null, expiresAt: number }>} */
const profileCache = new Map();

function cacheTtlMs() {
  const sec = Number(process.env.ENRICHMENT_CACHE_TTL_SECONDS);
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec) * 1000 : 300_000;
}

function missCacheTtlMs() {
  const sec = Number(process.env.ENRICHMENT_CACHE_MISS_TTL_SECONDS);
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec) * 1000 : 60_000;
}

function getToken() {
  return (process.env.APIFY_API_TOKEN || '').trim();
}

function apifyTimeoutMs() {
  const n = Number(process.env.ENRICHMENT_APIFY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
}

function withTimeout(promise, ms, code = 'APIFY_TIMEOUT') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('Apify request timed out');
      err.code = code;
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeUsername(username) {
  return String(username || '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
}

function getCachedProfile(cacheKey) {
  const hit = profileCache.get(cacheKey);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    profileCache.delete(cacheKey);
    return undefined;
  }
  return hit.raw;
}

function setCachedProfile(cacheKey, raw, ttlMs) {
  profileCache.set(cacheKey, {
    raw,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Run Instagram Profile Scraper actor for one username (uncached).
 * @returns {Promise<object|null>} First dataset item or null
 */
async function runApifyInstagramProfile(clean) {
  const token = getToken();
  if (!token) {
    const err = new Error('Apify API token is not configured');
    err.code = 'APIFY_NOT_CONFIGURED';
    throw err;
  }

  const client = new ApifyClient({ token });
  const input = { usernames: [clean] };

  const timeoutMs = apifyTimeoutMs();
  const run = await withTimeout(
    client.actor(ACTOR_ID).call(input),
    timeoutMs,
  );
  const { items } = await withTimeout(
    client.dataset(run.defaultDatasetId).listItems({ limit: 1 }),
    timeoutMs,
  );

  return items?.[0] ?? null;
}

/**
 * Run Instagram Profile Scraper actor for one username.
 * @returns {Promise<object|null>} First dataset item or null
 */
async function fetchInstagramProfileRaw(username) {
  const clean = normalizeUsername(username);

  if (!USERNAME_RE.test(clean)) {
    const err = new Error('Invalid Instagram username');
    err.code = 'INVALID_USERNAME';
    throw err;
  }

  const cached = getCachedProfile(clean);
  if (cached !== undefined) {
    return cached;
  }

  const raw = await runApifyInstagramProfile(clean);
  setCachedProfile(clean, raw, raw ? cacheTtlMs() : missCacheTtlMs());
  return raw;
}

function clearProfileCache() {
  profileCache.clear();
}

/**
 * Stable DTO for the frontend (field names vary slightly in raw Apify output).
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const profilePicUrlHd =
    raw.profilePicUrlHD ||
    raw.profile_pic_url_hd ||
    null;
  const pic =
    profilePicUrlHd ||
    raw.profilePicUrl ||
    raw.profilePictureUrl ||
    raw.profile_pic_url ||
    null;
  const profilePicUrls = [
    profilePicUrlHd,
    raw.profilePicUrl,
    raw.profilePictureUrl,
    raw.profile_pic_url,
  ].filter(Boolean);

  const detailKeys = [
    'id',
    'url',
    'inputUrl',
    'accountType',
    'businessCategoryName',
    'categoryName',
    'businessEmail',
    'businessPhoneNumber',
    'connectedFbPage',
    'hasChannel',
    'highlightReelCount',
    'igtvVideoCount',
    'joinedRecently',
    'blockedByViewer',
    'restrictedByViewer',
    'countryBlock',
    'externalUrlShimmed',
  ];

  const details = {};
  for (const key of detailKeys) {
    if (raw[key] != null && raw[key] !== '') details[key] = raw[key];
  }

  if (Array.isArray(raw.latestPosts)) {
    details.latestPosts = raw.latestPosts
      .filter((post) => post && typeof post === 'object')
      .slice(0, 6)
      .map((post) => ({
        id: post.id ?? post.shortCode ?? null,
        url: post.url ?? post.displayUrl ?? null,
        caption: post.caption ?? null,
        likesCount: post.likesCount ?? null,
        commentsCount: post.commentsCount ?? null,
        timestamp: post.timestamp ?? post.takenAtTimestamp ?? null,
        type: post.type ?? post.productType ?? null,
      }));
  }

  return {
    username: raw.username ?? null,
    fullName: raw.fullName ?? raw.full_name ?? null,
    biography: raw.biography ?? raw.biographyWithEntities ?? null,
    followersCount:
      typeof raw.followersCount === 'number'
        ? raw.followersCount
        : typeof raw.followers === 'number'
          ? raw.followers
          : null,
    followsCount:
      typeof raw.followsCount === 'number'
        ? raw.followsCount
        : typeof raw.following === 'number'
          ? raw.following
          : null,
    postsCount:
      typeof raw.postsCount === 'number'
        ? raw.postsCount
        : typeof raw.posts === 'number'
          ? raw.posts
          : null,
    isVerified: Boolean(raw.verified ?? raw.isVerified),
    isPrivate: Boolean(raw.private ?? raw.isPrivate),
    isBusiness: Boolean(raw.isBusinessAccount ?? raw.is_business),
    externalUrl: raw.externalUrl ?? raw.external_url ?? null,
    profilePicUrl: pic,
    profilePicUrlHd,
    profilePicUrls: [...new Set(profilePicUrls)],
    url: raw.url ?? (raw.username ? `https://www.instagram.com/${raw.username}/` : null),
    accountType: raw.accountType ?? null,
    businessCategoryName: raw.businessCategoryName ?? null,
    categoryName: raw.categoryName ?? null,
    businessEmail: raw.businessEmail ?? null,
    businessPhoneNumber: raw.businessPhoneNumber ?? null,
    highlightReelCount:
      typeof raw.highlightReelCount === 'number' ? raw.highlightReelCount : null,
    igtvVideoCount:
      typeof raw.igtvVideoCount === 'number' ? raw.igtvVideoCount : null,
    joinedRecently: raw.joinedRecently ?? null,
    details,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchInstagramProfileRaw,
  runApifyInstagramProfile,
  normalizeProfile,
  normalizeUsername,
  getToken,
  clearProfileCache,
  ACTOR_ID,
};
