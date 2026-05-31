const crypto = require('crypto');
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

function toInfluencerRow(creator, fallbackSourceUrl) {
  const profileUrl = `https://instagram.com/${creator.handle}`;
  const sourceUrl = creator.sourceUrl || fallbackSourceUrl || null;
  const followerFromText =
    parseFollowerCount(creator.followerText) ?? parseFollowerCount(creator.evidenceSnippet);

  return {
    id: makeId(profileUrl),
    name: creator.displayName || `@${creator.handle}`,
    handle: creator.handle,
    profileUrl,
    platform: 'instagram',
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
  const raw = (process.env.DISCOVERY_SEARCH_MODE || 'auto').toLowerCase().trim();
  if (raw === 'api' || raw === 'serp' || raw === 'auto') return raw;
  return 'auto';
}

async function performSearch({ query, searchLimit }) {
  const mode = searchModeFromEnv();
  const limit = Math.min(query.limit ?? 10, searchLimit);

  if (mode === 'serp') {
    const r = await searchInstagramCreatorsViaScraper({ ...query, limit });
    return { ...r, searchProvider: 'serp' };
  }

  if (mode === 'api') {
    const r = await searchInstagramCreators({ ...query, limit });
    return { ...r, searchProvider: 'anakin-search' };
  }

  try {
    const r = await searchInstagramCreators({ ...query, limit });
    if ((r.rawResults?.length ?? 0) > 0) {
      return { ...r, searchProvider: 'anakin-search' };
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
  return { ...r, searchProvider: 'serp-fallback' };
}

async function runDiscoveryPipeline(query) {
  const searchMode = searchModeFromEnv();
  const searchLimit = envInt('DISCOVERY_SEARCH_LIMIT', 5);
  const articleScrapeMax = envInt('DISCOVERY_ARTICLE_SCRAPE_MAX', 3);
  const groqRequired = envBool('DISCOVERY_GROQ_REQUIRED', true);
  const anakinGenerateJson = envBool('DISCOVERY_ANAKIN_GENERATE_JSON', true);
  const resolvedGroqModel = getGroqModelId();

  let search;
  try {
    search = await performSearch({ query, searchLimit });
  } catch (err) {
    throw tagStage(err, err.stage || 'search');
  }

  logDiscovery('search_complete', {
    searchMode,
    searchProvider: search.searchProvider,
    resultCount: search.rawResults?.length ?? 0,
    serpUrl: search.serpUrl ? String(search.serpUrl).slice(0, 120) : undefined,
  });

  const candidateUrls = (search.rawResults || [])
    .map((r) => r?.url)
    .filter((url) => url && !isInstagramProfileUrl(url))
    .slice(0, articleScrapeMax);

  let scrapedArticles = [];
  if (articleScrapeMax > 0 && candidateUrls.length > 0) {
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
    anakin: 'url-scraper',
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
      query,
      searchResults: search.rawResults,
      scrapedArticles,
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

  if (groqCreators.length > 0) {
    const fallbackUrl = search.rawResults?.[0]?.url || null;
    const influencers = sortByFollowersDesc(
      groqCreators.map((c) => toInfluencerRow(c, fallbackUrl)),
    );
    const llm = llmStagesForResponse();
    logDiscovery('pipeline_complete', {
      outcome: 'groq_rows',
      influencerCount: influencers.length,
      ...llm,
    });
    return {
      influencers,
      requestId: search.requestId,
      prompt: search.prompt,
      stages: {
        searchMode,
        searchProvider: search.searchProvider,
        search: search.rawResults?.length ?? 0,
        scrapedArticles: scrapedArticles.length,
        anakinGenerateJson,
        groqCreators: groqCreators.length,
        usedFallback: false,
        ...llm,
      },
    };
  }

  if (groqRequired && groqError && groqError.code !== 'GROQ_KEY_MISSING') {
    throw groqError;
  }

  const fallbackInfluencers = mapAnakinResults(search.rawResults || []);
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
      searchMode,
      searchProvider: search.searchProvider,
      search: search.rawResults?.length ?? 0,
      scrapedArticles: scrapedArticles.length,
      anakinGenerateJson,
      groqCreators: 0,
      usedFallback: true,
      ...llm,
    },
  };
}

module.exports = {
  runDiscoveryPipeline,
  toInfluencerRow,
};
