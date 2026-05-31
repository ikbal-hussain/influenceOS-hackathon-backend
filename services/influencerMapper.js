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
  extractInstagramHandle,
  sortByFollowersDesc,
};
