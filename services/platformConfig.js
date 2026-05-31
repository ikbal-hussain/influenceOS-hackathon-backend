/**
 * Per-platform discovery contract — single source of truth for Wire, URLs, UI labels.
 */

const SUPPORTED_PLATFORMS = ['instagram', 'youtube'];

const PLATFORM_CONFIG = {
  instagram: {
    wireActionId: 'yt_search',
    wireEnrichActionId: null,
    allowedProfileHosts: ['instagram.com', 'www.instagram.com'],
    metricLabel: 'Followers',
    enrichmentType: 'apify-instagram',
    buildWireSearchQuery({ niche, location, audienceType }) {
      return ['instagram', niche, location, 'influencers', audienceType].filter(Boolean).join(' ');
    },
    defaultWireParams(query) {
      const limit = query.limit ?? 10;
      return {
        query: this.buildWireSearchQuery(query),
        maxResults: Math.min(limit + 5, 25),
      };
    },
  },
  youtube: {
    wireActionId: 'yt_search',
    wireEnrichActionId: 'yt_channel',
    allowedProfileHosts: ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'],
    metricLabel: 'Subscribers',
    enrichmentType: 'wire-youtube',
    buildWireSearchQuery({ niche, location, audienceType }) {
      return [niche, 'youtuber', location, audienceType, 'channel vlog'].filter(Boolean).join(' ');
    },
    defaultWireParams(query) {
      const limit = query.limit ?? 10;
      return {
        query: this.buildWireSearchQuery(query),
        maxResults: Math.min(Math.max(limit * 2, 12), 25),
      };
    },
  },
};

function normalizePlatform(platform) {
  const s = String(platform || 'instagram').toLowerCase().trim();
  return s === 'youtube' ? 'youtube' : 'instagram';
}

function getPlatformConfig(platform) {
  const p = normalizePlatform(platform);
  return { key: p, ...PLATFORM_CONFIG[p] };
}

function isSupportedPlatform(platform) {
  return SUPPORTED_PLATFORMS.includes(normalizePlatform(platform));
}

function urlHostMatchesPlatform(url, platform) {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const allowed = getPlatformConfig(platform).allowedProfileHosts.map((h) =>
      h.replace(/^www\./, ''),
    );
    return allowed.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function sanitizeCreatorForPlatform(creator, platform) {
  const p = normalizePlatform(platform);
  const profileOk = !creator.profileUrl || urlHostMatchesPlatform(creator.profileUrl, p);
  const sourceOk = !creator.sourceUrl || urlHostMatchesPlatform(creator.sourceUrl, p);
  const handle =
    typeof creator.handle === 'string' ? creator.handle.replace(/^@/, '').trim() : '';
  // Wire+Groq Instagram rows often only have @handle + a YouTube source URL.
  if (p === 'instagram' && handle && !profileOk && !sourceOk) {
    return { ...creator, platform: p };
  }
  if (!profileOk && !sourceOk && p === 'youtube' && creator.channelId) {
    return {
      ...creator,
      profileUrl: `https://www.youtube.com/channel/${creator.channelId}`,
      platform: p,
    };
  }
  if (!profileOk && creator.profileUrl && p === 'instagram') {
    return null;
  }
  if (!profileOk && creator.profileUrl && p === 'youtube') {
    return null;
  }
  return { ...creator, platform: p };
}

module.exports = {
  SUPPORTED_PLATFORMS,
  PLATFORM_CONFIG,
  normalizePlatform,
  getPlatformConfig,
  isSupportedPlatform,
  urlHostMatchesPlatform,
  sanitizeCreatorForPlatform,
};
