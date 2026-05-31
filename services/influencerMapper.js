const crypto = require('crypto');

const FOLLOWER_REGEX = /([\d]+(?:[.,]\d+)?)\s*([kKmMbB])?\s*(?:\+\s*)?(?:followers|fans|subscribers|subs)/;
const FOLLOWER_REGEX_REVERSE = /(?:followers|fans|subscribers|subs)\b[^\d]{0,20}([\d]+(?:[.,]\d+)?)\s*([kKmMbB])?/i;
const INSTAGRAM_PROFILE_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})\/?/i;

function parseFollowerCount(text) {
  if (!text) return null;
  const str = String(text);
  const match = str.match(FOLLOWER_REGEX) || str.match(FOLLOWER_REGEX_REVERSE);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  if (Number.isNaN(num)) return null;
  const unit = (match[2] || '').toLowerCase();
  const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === 'b' ? 1_000_000_000 : 1;
  return Math.round(num * multiplier);
}

const YT_SUBSCRIBERS_AFTER =
  /([\d][\d.,]*)\s*([kKmMbB])?\s*subscribers\b/i;
const YT_SUBSCRIBERS_BEFORE =
  /\bsubscribers\b[^\d]{0,20}([\d][\d.,]*)\s*([kKmMbB])?/i;

function hasViewsNear(text, index) {
  const window = text.slice(Math.max(0, index - 45), index + 45).toLowerCase();
  return /\bviews?\b/.test(window);
}

/**
 * Parse YouTube channel subscriber count from scraped page markdown.
 * Returns { count, text } — rejects matches near "views".
 */
function parseYouTubeSubscriberCount(text) {
  if (!text) return { count: null, text: null };
  const str = String(text);
  const patterns = [YT_SUBSCRIBERS_AFTER, YT_SUBSCRIBERS_BEFORE];

  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags + 'g');
    let match;
    while ((match = re.exec(str)) !== null) {
      if (hasViewsNear(str, match.index)) continue;
      const num = Number(match[1].replace(/,/g, ''));
      if (!Number.isFinite(num)) continue;
      const unit = (match[2] || '').toLowerCase();
      const mult =
        unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === 'b' ? 1_000_000_000 : 1;
      return { count: Math.round(num * mult), text: match[0].trim() };
    }
  }

  return { count: null, text: null };
}

function extractInstagramHandle(url, title) {
  const fromUrl = url && url.match(INSTAGRAM_PROFILE_REGEX);
  if (fromUrl && fromUrl[1] && !['p', 'reel', 'tv', 'explore'].includes(fromUrl[1])) {
    return fromUrl[1];
  }
  const fromTitle = title && title.match(/@([A-Za-z0-9_.]{1,30})/);
  return fromTitle ? fromTitle[1] : null;
}

function deriveName(title, handle) {
  if (!title && handle) return `@${handle}`;
  if (!title) return 'Unknown creator';
  const cleaned = title
    .replace(/\s*[\u2022\-|·]\s*Instagram(\s+photos\s+and\s+videos)?/i, '')
    .replace(/\s*\(@[^)]+\)/, '')
    .trim();
  return cleaned || (handle ? `@${handle}` : 'Unknown creator');
}

function makeId(url, fallback, index) {
  const base = url || fallback || `result-${index}`;
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function mapResultToInfluencer(result, index) {
  const url = result?.url || '';
  const title = result?.title || '';
  const snippet = result?.snippet || '';

  const handle = extractInstagramHandle(url, title);
  const profileUrl = handle ? `https://instagram.com/${handle}` : url || null;
  const followerCount = parseFollowerCount(snippet) ?? parseFollowerCount(title);

  return {
    id: makeId(profileUrl || url, handle, index),
    name: deriveName(title, handle),
    handle: handle || null,
    profileUrl,
    platform: 'instagram',
    snippet,
    sourceUrl: url || null,
    followerCount,
    publishedAt: result?.date || null,
  };
}

function dedupeByProfileUrl(influencers) {
  const seen = new Map();
  for (const item of influencers) {
    const key = item.profileUrl || item.sourceUrl || item.id;
    if (!seen.has(key)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

function sortByFollowersDesc(influencers) {
  return [...influencers].sort((a, b) => {
    const aHas = typeof a.followerCount === 'number';
    const bHas = typeof b.followerCount === 'number';
    if (aHas && bHas) return b.followerCount - a.followerCount;
    if (aHas) return -1;
    if (bHas) return 1;
    return 0;
  });
}

function mapAnakinResults(rawResults) {
  const mapped = rawResults.map(mapResultToInfluencer);
  return sortByFollowersDesc(dedupeByProfileUrl(mapped));
}

module.exports = {
  mapAnakinResults,
  mapResultToInfluencer,
  parseFollowerCount,
  parseYouTubeSubscriberCount,
  extractInstagramHandle,
  sortByFollowersDesc,
};
