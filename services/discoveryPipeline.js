const crypto = require('crypto');
const {
  searchCreatorsViaWire,
  normalizePlatform,
  enrichYouTubeCreators,
  mapYouTubeWireToCreators,
} = require('./anakinWire');
const { searchInstagramCreators } = require('./anakinSearch');
const { searchInstagramCreatorsViaScraper } = require('./anakinSerpSearch');
const { scrapeArticles, isInstagramProfileUrl } = require('./anakinUrlScraper');
const { extractCreators, getGroqModelId } = require('./groqExtractCreators');
const { mapAnakinResults, parseFollowerCount, sortByFollowersDesc } = require('./influencerMapper');
const { logDiscovery } = require('./discoveryLog');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function makeId(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function toInfluencerRow(creator, fallbackSourceUrl, platform) {
  const p = normalizePlatform(platform || creator.platform);
  const profileUrl =
    creator.profileUrl ||
    (p === 'youtube'
      ? `https://www.youtube.com/channel/${creator.handle}`
      : `https://instagram.com/${creator.handle}`);
  const sourceUrl = creator.sourceUrl || fallbackSourceUrl || null;
  const followerFromText =
    parseFollowerCount(creator.followerText) ?? parseFollowerCount(creator.evidenceSnippet);

  const displayName =
    creator.displayName ||
    (p === 'youtube' && creator.handle && !String(creator.handle).startsWith('UC')
      ? creator.handle
      : null) ||
    (p === 'youtube' ? 'YouTube creator' : `@${creator.handle}`);

  return {
    id: makeId(profileUrl),
    name: displayName,
    handle:
      p === 'youtube' && creator.handle && !String(creator.handle).startsWith('UC')
        ? creator.handle
        : creator.handle,
    profileUrl,
    platform: p,
    snippet: creator.evidenceSnippet || '',
    sourceUrl,
    followerCount: followerFromText,
    publishedAt: null,
  };
}

function tagStage(err, stage) {
  if (err && typeof err === 'object') err.stage = stage;
  return err;
}

function searchModeFromEnv() {
  const raw = (process.env.DISCOVERY_SEARCH_MODE || 'wire').toLowerCase().trim();
  if (raw === 'api' || raw === 'serp' || raw === 'auto' || raw === 'wire') return raw;
  return 'wire';
}

/** Anakin Build-a-thon: discovery must use Holocron / Wire (default on). */
function wireRequired() {
  return envBool('DISCOVERY_WIRE_REQUIRED', true);
}

async function performSearch({ query, searchLimit }) {
  const mode = searchModeFromEnv();
  const limit = Math.min(query.limit ?? 10, searchLimit);
  const platform = normalizePlatform(query.platform);
  const mustUseWire = wireRequired() || mode === 'wire';

  if (mustUseWire) {
    const r = await searchCreatorsViaWire({ ...query, platform, limit });
    return { ...r, searchProvider: 'anakin-wire', wireUsed: true };
  }

  if (mode === 'serp') {
    const r = await searchInstagramCreatorsViaScraper({ ...query, limit });
    return { ...r, searchProvider: 'serp', wireUsed: false };
  }

  if (mode === 'api') {
    const r = await searchInstagramCreators({ ...query, limit });
    return { ...r, searchProvider: 'anakin-search', wireUsed: false };
  }

  try {
    const r = await searchInstagramCreators({ ...query, limit });
    if ((r.rawResults?.length ?? 0) > 0) {
      return { ...r, searchProvider: 'anakin-search', wireUsed: false };
    }
    console.warn('[discoveryPipeline] anakin /v1/search returned 0 results, falling back to SERP scrape');
  } catch (err) {
    if (err.code === 'ANAKIN_KEY_MISSING') throw tagStage(err, 'anakin-search');
    console.warn(
      '[discoveryPipeline] anakin /v1/search failed, falling back to SERP scrape:',
      err.response?.status ?? '',
      err.message,
    );
  }

  const r = await searchInstagramCreatorsViaScraper({ ...query, limit });
  return { ...r, searchProvider: 'serp-fallback', wireUsed: false };
}

function baseStages(searchMode, search, llm = {}) {
  return {
    searchMode,
    searchProvider: search.searchProvider,
    wireUsed: Boolean(search.wireUsed),
    wireActionId: search.actionId ?? null,
    holocronCatalog: 'wire',
    search: search.rawResults?.length ?? 0,
    ...llm,
  };
}

async function runDiscoveryPipeline(query) {
  const searchMode = searchModeFromEnv();
  const platform = normalizePlatform(query.platform);
  const searchLimit = envInt('DISCOVERY_SEARCH_LIMIT', 5);
  const articleScrapeMax = wireRequired()
    ? envInt('DISCOVERY_ARTICLE_SCRAPE_MAX', 0)
    : envInt('DISCOVERY_ARTICLE_SCRAPE_MAX', 3);
  const groqRequired = envBool('DISCOVERY_GROQ_REQUIRED', true);
  const anakinGenerateJson = envBool('DISCOVERY_ANAKIN_GENERATE_JSON', true);
  const resolvedGroqModel = getGroqModelId();

  let search;
  try {
    search = await performSearch({ query: { ...query, platform }, searchLimit });
  } catch (err) {
    throw tagStage(err, err.stage || 'anakin-wire');
  }

  logDiscovery('search_complete', {
    searchMode,
    searchProvider: search.searchProvider,
    wireUsed: search.wireUsed,
    resultCount: search.rawResults?.length ?? 0,
    wireActionId: search.actionId ? String(search.actionId).slice(0, 80) : undefined,
    wireCreators: search.wireCreators?.length ?? 0,
    platform,
  });

  const candidateUrls = (search.rawResults || [])
    .map((r) => r?.url)
    .filter((url) => url && !isInstagramProfileUrl(url))
    .slice(0, articleScrapeMax);

  let scrapedArticles = [];
  if (articleScrapeMax > 0 && candidateUrls.length > 0 && !search.wireUsed) {
    try {
      scrapedArticles = await scrapeArticles(candidateUrls, {
        concurrency: 2,
        generateJson: anakinGenerateJson,
      });
    } catch (err) {
      console.warn('[discoveryPipeline] article scrape failed:', err.message);
    }
  }

  logDiscovery('scrape_complete', {
    anakin: search.wireUsed ? 'holocron-wire' : 'url-scraper',
    articleScrapeMax,
    candidates: candidateUrls.length,
    scrapedCount: scrapedArticles.length,
    anakinGenerateJson,
  });

  let groqCreators = [];
  let groqError = null;
  let groqMeta = null;
  try {
    const out = await extractCreators({
      query: { ...query, platform },
      searchResults: search.rawResults,
      scrapedArticles,
      wirePayload: search.wireUsed ? search.wirePayload : null,
      limit: query.limit ?? 10,
    });
    groqCreators = out.creators || [];
    groqMeta = out.meta || null;
  } catch (err) {
    groqError = tagStage(err, 'groq');
    logDiscovery('llm_result', {
      llmProvider: 'groq',
      llmModel: resolvedGroqModel,
      llm_error: true,
      status: err.response?.status ?? null,
      code: err.code || null,
    });
    if (err.code === 'GROQ_KEY_MISSING' && groqRequired) {
      throw err;
    }
    console.warn(
      '[discoveryPipeline] groq extraction failed:',
      err.message,
      err.response?.status ?? '',
    );
  }

  function llmStagesForResponse() {
    let llmProvider = 'none';
    let llmStatus = 'skipped';
    if (groqCreators.length > 0) {
      llmProvider = 'groq';
      llmStatus = 'ok';
    } else if (groqError) {
      llmProvider = 'groq';
      llmStatus = 'error';
    } else if (groqMeta?.reason === 'no_sources') {
      llmProvider = 'none';
      llmStatus = 'skipped';
    } else if (groqMeta?.llmInvoked) {
      llmProvider = 'groq';
      llmStatus = 'ok';
    }
    const llmModel =
      llmProvider === 'groq' ? groqMeta?.llmModel || resolvedGroqModel : null;
    return { llmProvider, llmStatus, llmModel };
  }

  if (platform === 'youtube' && groqCreators.length > 0) {
    const enrichMax = envInt('DISCOVERY_YOUTUBE_ENRICH_MAX', 8);
    const toEnrich = groqCreators.slice(0, enrichMax);
    try {
      const enriched = await enrichYouTubeCreators(toEnrich, { concurrency: 2 });
      groqCreators = [...enriched, ...groqCreators.slice(enrichMax)];
    } catch (err) {
      console.warn('[discoveryPipeline] YouTube yt_channel enrich failed:', err.message);
    }
  }

  if (groqCreators.length > 0) {
    const fallbackUrl = search.rawResults?.[0]?.url || null;
    const influencers = sortByFollowersDesc(
      groqCreators.map((c) => toInfluencerRow(c, fallbackUrl, platform)),
    );
    const llm = llmStagesForResponse();
    logDiscovery('pipeline_complete', {
      outcome: search.wireUsed ? 'wire_groq_rows' : 'groq_rows',
      influencerCount: influencers.length,
      ...llm,
    });
    return {
      influencers,
      requestId: search.requestId,
      prompt: search.prompt,
      stages: {
        ...baseStages(searchMode, search, {
          scrapedArticles: scrapedArticles.length,
          anakinGenerateJson,
          groqCreators: groqCreators.length,
          usedFallback: false,
          ...llm,
        }),
      },
    };
  }

  if (groqRequired && groqError && groqError.code !== 'GROQ_KEY_MISSING') {
    throw groqError;
  }

  let fallbackInfluencers = mapAnakinResults(search.rawResults || []);

  if (platform === 'youtube' && search.wirePayload?.data) {
    const wireRows = mapYouTubeWireToCreators(
      search.wirePayload.data,
      query.limit ?? 10,
      query,
    );
    if (wireRows.length > 0) {
      const enrichMax = envInt('DISCOVERY_YOUTUBE_ENRICH_MAX', 8);
      let enriched = wireRows;
      try {
        enriched = await enrichYouTubeCreators(wireRows.slice(0, enrichMax), { concurrency: 2 });
        enriched = [...enriched, ...wireRows.slice(enrichMax)];
      } catch (err) {
        console.warn('[discoveryPipeline] YouTube wire fallback enrich failed:', err.message);
      }
      fallbackInfluencers = sortByFollowersDesc(
        enriched.map((c) => toInfluencerRow(c, c.sourceUrl, 'youtube')),
      );
    }
  }
  const llm = llmStagesForResponse();
  logDiscovery('pipeline_complete', {
    outcome: 'fallback_mapper',
    influencerCount: fallbackInfluencers.length,
    ...llm,
  });
  return {
    influencers: fallbackInfluencers,
    requestId: search.requestId,
    prompt: search.prompt,
    stages: {
      ...baseStages(searchMode, search, {
        scrapedArticles: scrapedArticles.length,
        anakinGenerateJson,
        groqCreators: 0,
        usedFallback: true,
        ...llm,
      }),
    },
  };
}

module.exports = {
  runDiscoveryPipeline,
  toInfluencerRow,
  wireRequired,
};
