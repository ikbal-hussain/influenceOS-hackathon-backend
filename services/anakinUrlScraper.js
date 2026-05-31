const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.anakin.io/v1';
const POLL_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_START_MS = 1_000;
const POLL_INTERVAL_MAX_MS = 2_500;
const INSTAGRAM_PROFILE_HOST = /(?:^|\.)instagram\.com$/i;

function getConfig() {
  const apiKey = process.env.ANAKIN_API_KEY;
  const baseUrl = (process.env.ANAKIN_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return { apiKey, baseUrl };
}

function isInstagramProfileUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!INSTAGRAM_PROFILE_HOST.test(parsed.hostname)) return false;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return false;
    if (['p', 'reel', 'reels', 'tv', 'explore', 'stories'].includes(path.split('/')[0])) {
      return false;
    }
    return /^[A-Za-z0-9_.]{1,30}$/.test(path.split('/')[0]);
  } catch {
    return false;
  }
}

async function submitScrapeJob(url, { useBrowser = false, generateJson = false } = {}) {
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    const err = new Error('Anakin API key is not configured');
    err.code = 'ANAKIN_KEY_MISSING';
    throw err;
  }

  const response = await axios.post(
    `${baseUrl}/url-scraper`,
    { url, useBrowser, generateJson },
    {
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      timeout: 15_000,
    },
  );

  return response.data?.jobId || response.data?.id || null;
}

async function fetchScrapeResult(jobId) {
  const { apiKey, baseUrl } = getConfig();
  const response = await axios.get(`${baseUrl}/url-scraper/${jobId}`, {
    headers: { 'X-API-Key': apiKey },
    timeout: 10_000,
  });
  return response.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilComplete(jobId, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let interval = POLL_INTERVAL_START_MS;

  while (Date.now() < deadline) {
    const data = await fetchScrapeResult(jobId);
    const status = data?.status;
    if (status === 'completed') return data;
    if (status === 'failed') {
      const err = new Error(data?.error || 'Scrape job failed');
      err.code = 'SCRAPE_FAILED';
      throw err;
    }
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), POLL_INTERVAL_MAX_MS);
  }

  const err = new Error(`Scrape job ${jobId} timed out`);
  err.code = 'SCRAPE_TIMEOUT';
  throw err;
}

function hasGeneratedJsonPayload(generatedJson) {
  if (!generatedJson || typeof generatedJson !== 'object') return false;
  if (generatedJson.status === 'failed') return false;
  if (generatedJson.status === 'success' && generatedJson.data != null) return true;
  if (generatedJson.data != null && typeof generatedJson.data === 'object') return true;
  return false;
}

async function scrapeMarkdown(url, options) {
  const jobId = await submitScrapeJob(url, options);
  if (!jobId) throw new Error('Anakin scraper did not return a jobId');
  const result = await pollUntilComplete(jobId);
  const markdown = result?.markdown || '';
  const generatedJson =
    result?.generatedJson != null ? result.generatedJson : result?.generated_json ?? null;
  return {
    url,
    jobId,
    status: result?.status || 'completed',
    markdown,
    generatedJson,
    cached: Boolean(result?.cached),
    durationMs: result?.durationMs ?? null,
  };
}

async function withConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function runOne() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err };
      }
    }
  }

  const runners = Array.from({ length: workerCount }, () => runOne());
  await Promise.all(runners);
  return results;
}

async function scrapeArticles(urls, { concurrency = 3, useBrowser = false, generateJson = false } = {}) {
  const articleUrls = urls.filter((url) => url && !isInstagramProfileUrl(url));
  if (articleUrls.length === 0) return [];

  const results = await withConcurrency(articleUrls, concurrency, (url) =>
    scrapeMarkdown(url, { useBrowser, generateJson }),
  );

  return results
    .map((res, idx) => {
      if (!res || res.error) {
        return {
          url: articleUrls[idx],
          markdown: '',
          status: 'failed',
          error: res?.error?.message || 'Unknown scrape error',
        };
      }
      return res;
    })
    .filter((r) => {
      const md = Boolean(r.markdown && r.markdown.trim().length > 0);
      return md || hasGeneratedJsonPayload(r.generatedJson);
    });
}

module.exports = {
  scrapeArticles,
  scrapeMarkdown,
  isInstagramProfileUrl,
  hasGeneratedJsonPayload,
};
