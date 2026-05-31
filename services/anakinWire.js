const axios = require('axios');
const { parseYouTubeSubscriberCount } = require('./influencerMapper');
const {
  normalizePlatform,
  getPlatformConfig,
  urlHostMatchesPlatform,
} = require('./platformConfig');
const { scrapeMarkdown } = require('./anakinUrlScraper');
const { logDiscovery } = require('./discoveryLog');

const DEFAULT_BASE_URL = 'https://api.anakin.io/v1';
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_START_MS = 1_000;
const POLL_INTERVAL_MAX_MS = 3_000;
const INSTAGRAM_HANDLE_REGEX = /^[A-Za-z0-9_.]{1,30}$/;

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function subscriberScrapeEnabled() {
  return envBool('DISCOVERY_YOUTUBE_SUBSCRIBER_SCRAPE', true);
}

function recordApi(apisUsed, entry) {
  if (apisUsed && !apisUsed.includes(entry)) apisUsed.push(entry);
}

function getConfig() {
  const apiKey = process.env.ANAKIN_API_KEY;
  const baseUrl = (process.env.ANAKIN_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return { apiKey, baseUrl };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Titles that are usually commentary about influencers, not creator channels. */
const YOUTUBE_META_TITLE =
  /\b(exposing|ranking|ranked|tier list|top \d+|natty or not|dark reality|chhapri|roast|drama|podcast|interview|news|documentary|vs\.|reaction|commentary|worst|best of|list of)\b/i;

function buildYouTubeWireSearchQuery({ niche, location, audienceType }) {
  return [niche, 'youtuber', location, audienceType, 'channel vlog']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function buildDiscoveryQuery({ niche, location, audienceType, platform }) {
  const p = normalizePlatform(platform);
  if (p === 'youtube') {
    return buildYouTubeWireSearchQuery({ niche, location, audienceType });
  }
  return [niche, location, audienceType, 'instagram creators influencers']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function interpolateTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v == null ? '' : String(v);
    }
    return '';
  });
}

function parseWireParamsJson(platform) {
  const key =
    platform === 'youtube' ? 'ANAKIN_WIRE_PARAMS_JSON_YOUTUBE' : 'ANAKIN_WIRE_PARAMS_JSON_INSTAGRAM';
  const raw = process.env[key] || process.env.ANAKIN_WIRE_PARAMS_JSON;
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const err = new Error(`${key} / ANAKIN_WIRE_PARAMS_JSON must be valid JSON`);
    err.code = 'WIRE_PARAMS_INVALID';
    throw err;
  }
}

function buildWireParams(query) {
  const platform = normalizePlatform(query.platform);
  const discoveryQuery = buildDiscoveryQuery(query);
  const limit = query.limit ?? 10;
  const vars = {
    niche: query.niche || '',
    location: query.location || '',
    audienceType: query.audienceType || '',
    query: discoveryQuery,
    limit,
  };
  const template = parseWireParamsJson(platform);
  if (Object.keys(template).length === 0) {
    if (platform === 'youtube') {
      return {
        query: buildYouTubeWireSearchQuery(query),
        maxResults: Math.min(Math.max(limit * 2, 12), 25),
      };
    }
    return {
      query: ['instagram', query.niche, query.location, 'influencers', query.audienceType]
        .filter(Boolean)
        .join(' '),
      maxResults: Math.min(limit + 5, 25),
    };
  }
  const out = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === 'string') {
      out[key] = interpolateTemplate(value, vars);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function holocronGet(path) {
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    const err = new Error('Anakin API key is not configured');
    err.code = 'ANAKIN_KEY_MISSING';
    throw err;
  }
  return axios.get(`${baseUrl}${path}`, {
    headers: { 'X-API-Key': apiKey },
    timeout: 20_000,
    validateStatus: () => true,
  });
}

async function holocronSearch(q) {
  const res = await holocronGet(`/holocron/search?q=${encodeURIComponent(q)}`);
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Holocron search rejected the API key');
    err.code = 'ANAKIN_UNAUTHORIZED';
    err.response = res;
    throw err;
  }
  if (res.status >= 400) {
    const err = new Error(`Holocron search failed (${res.status})`);
    err.code = 'WIRE_SEARCH_FAILED';
    err.response = res;
    throw err;
  }
  return Array.isArray(res.data?.results) ? res.data.results : [];
}

async function resolveWireActionId(query) {
  const platform = normalizePlatform(query.platform);
  const platformKey =
    platform === 'youtube' ? 'ANAKIN_WIRE_ACTION_ID_YOUTUBE' : 'ANAKIN_WIRE_ACTION_ID_INSTAGRAM';
  const explicit = (process.env[platformKey] || process.env.ANAKIN_WIRE_ACTION_ID || '').trim();
  if (explicit) return explicit;

  const searchQ = (process.env.ANAKIN_WIRE_SEARCH_QUERY || '').trim();
  if (searchQ) {
    const results = await holocronSearch(searchQ);
    const pick = results.find((r) => r.action_id && !r.auth_required) || results[0];
    if (!pick?.action_id) {
      const err = new Error(
        'No Wire action found for ANAKIN_WIRE_SEARCH_QUERY. Set ANAKIN_WIRE_ACTION_ID_* in .env',
      );
      err.code = 'WIRE_ACTION_MISSING';
      throw err;
    }
    if (pick.auth_required) {
      const err = new Error(
        `Wire action "${pick.action_id}" requires account auth in the Anakin dashboard`,
      );
      err.code = 'WIRE_AUTH_REQUIRED';
      err.actionId = pick.action_id;
      throw err;
    }
    return pick.action_id;
  }

  return getPlatformConfig(platform).wireActionId;
}

async function submitWireTask(actionId, params, ctx = {}) {
  const { apiKey, baseUrl } = getConfig();
  const response = await axios.post(
    `${baseUrl}/holocron/task`,
    { action_id: actionId, params },
    {
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      timeout: 20_000,
      validateStatus: () => true,
    },
  );

  if (response.status === 401 || response.status === 403) {
    const err = new Error('Wire task rejected the API key');
    err.code = 'ANAKIN_UNAUTHORIZED';
    err.response = response;
    throw err;
  }
  if (response.status === 402) {
    const err = new Error('Insufficient Anakin credits for Wire action');
    err.code = 'WIRE_INSUFFICIENT_CREDITS';
    err.response = response;
    throw err;
  }
  if (response.status >= 400) {
    const msg =
      response.data?.message ||
      response.data?.error ||
      `Wire task submit failed (${response.status})`;
    const err = new Error(msg);
    err.code = 'WIRE_TASK_FAILED';
    err.response = response;
    throw err;
  }

  const jobId = response.data?.jobId || response.data?.job_id || response.data?.id;
  if (!jobId) {
    const err = new Error('Wire task did not return a job id');
    err.code = 'WIRE_TASK_FAILED';
    throw err;
  }
  recordApi(ctx.apisUsed, `POST /v1/holocron/task#${actionId}`);
  return jobId;
}

async function fetchWireJob(jobId, ctx = {}) {
  const { apiKey, baseUrl } = getConfig();
  const response = await axios.get(`${baseUrl}/holocron/jobs/${jobId}`, {
    headers: { 'X-API-Key': apiKey },
    timeout: 15_000,
  });
  return response.data;
}

async function pollWireJob(jobId, { timeoutMs = POLL_TIMEOUT_MS, ctx = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let interval = POLL_INTERVAL_START_MS;

  while (Date.now() < deadline) {
    const data = await fetchWireJob(jobId, ctx);
    const status = data?.status;
    if (status === 'completed') return data;
    if (status === 'failed') {
      const err = new Error(
        typeof data?.error === 'object' && data.error?.message
          ? data.error.message
          : data?.error || 'Wire job failed',
      );
      err.code = 'WIRE_JOB_FAILED';
      throw err;
    }
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), POLL_INTERVAL_MAX_MS);
  }

  const err = new Error(`Wire job ${jobId} timed out`);
  err.code = 'WIRE_TIMEOUT';
  throw err;
}

async function runWireAction(actionId, params, ctx = {}) {
  const started = Date.now();
  const jobId = await submitWireTask(actionId, params, ctx);
  const result = await pollWireJob(jobId, { ctx });
  recordApi(ctx.apisUsed, `GET /v1/holocron/jobs/:id`);
  logDiscovery('wire_job_complete', {
    traceId: ctx.traceId,
    actionId,
    jobId,
    durationMs: Date.now() - started,
    status: result?.status,
  });
  return {
    jobId,
    actionId,
    data: result?.data ?? result,
    creditsUsed: result?.credits_used ?? null,
    executionMs: result?.execution_ms ?? null,
  };
}

function normalizeHandle(value) {
  if (!value || typeof value !== 'string') return null;
  let h = value.trim().replace(/^@/, '');
  const urlMatch = h.match(/instagram\.com\/([A-Za-z0-9_.]{1,30})/i);
  if (urlMatch) h = urlMatch[1];
  if (!INSTAGRAM_HANDLE_REGEX.test(h)) return null;
  if (['p', 'reel', 'reels', 'tv', 'explore', 'stories'].includes(h.toLowerCase())) return null;
  return h;
}

function pickString(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

function extractCreatorFromRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const handle =
    normalizeHandle(pickString(record, ['handle', 'username', 'user_name', 'userName', 'ig_username'])) ||
    normalizeHandle(pickString(record, ['profileUrl', 'profile_url', 'url', 'link']));

  if (!handle) return null;

  const displayName =
    pickString(record, ['displayName', 'display_name', 'full_name', 'fullName', 'name', 'title']) ||
    `@${handle}`;

  const followerCount = pickNumber(record, [
    'followerCount',
    'follower_count',
    'followers',
    'followers_count',
    'subscriber_count',
  ]);

  const bio = pickString(record, ['bio', 'biography', 'description', 'snippet', 'about']);
  const evidenceSnippet = bio || pickString(record, ['evidenceSnippet', 'caption', 'text']) || '';

  return {
    handle,
    displayName,
    followerText: followerCount != null ? String(followerCount) : null,
    evidenceSnippet,
    sourceUrl: pickString(record, ['sourceUrl', 'source_url', 'url', 'profileUrl', 'profile_url']),
    platform: 'instagram',
  };
}

function collectRecords(node, out, depth = 0) {
  if (depth > 8 || out.length > 200) return;
  if (node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) collectRecords(item, out, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  const creator = extractCreatorFromRecord(node);
  if (creator) out.push(creator);

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectRecords(value, out, depth + 1);
  }
}

function findYouTubeVideoRows(data) {
  if (!data || typeof data !== 'object') return [];
  const nested = data?.data?.data;
  if (Array.isArray(nested) && nested[0]?.channel_id) return nested;
  if (Array.isArray(data.data) && data.data[0]?.channel_id) return data.data;
  return [];
}

function scoreYouTubeVideo(video, query) {
  const title = String(video?.title || '');
  const channel = String(video?.channel || '');
  let score = 0;

  if (YOUTUBE_META_TITLE.test(title)) score -= 40;
  if (YOUTUBE_META_TITLE.test(channel)) score -= 15;

  const nicheWords = String(query?.niche || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  for (const word of nicheWords) {
    if (title.toLowerCase().includes(word)) score += 12;
    if (channel.toLowerCase().includes(word)) score += 18;
  }
  if (query?.location && title.toLowerCase().includes(query.location.toLowerCase())) {
    score += 8;
  }
  if (/\b(fitness|gym|workout|yoga|beauty|fashion|food|travel|tech)\b/i.test(channel)) {
    score += 5;
  }
  return score;
}

function parseYouTubeHandleFromUrl(url) {
  if (!url) return null;
  const at = url.match(/youtube\.com\/@([A-Za-z0-9._-]{2,50})/i);
  if (at) return at[1];
  return null;
}

function mapYouTubeWireToCreators(wireData, limit = 25, query = {}) {
  const videos = findYouTubeVideoRows(wireData);
  const byChannel = new Map();

  for (const v of videos) {
    const channelId = v.channel_id;
    if (!channelId) continue;
    const score = scoreYouTubeVideo(v, query);
    if (score < -10) continue;

    const candidate = {
      channelId,
      handle: channelId,
      displayName: v.channel || channelId,
      profileUrl: `https://www.youtube.com/channel/${channelId}`,
      evidenceSnippet: v.title || '',
      sourceUrl: v.url || `https://www.youtube.com/channel/${channelId}`,
      followerText: null,
      platform: 'youtube',
      _score: score,
    };

    const prev = byChannel.get(channelId);
    if (!prev || candidate._score > prev._score) {
      byChannel.set(channelId, candidate);
    }
  }

  return Array.from(byChannel.values())
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, channelId, ...rest }) => ({ ...rest, channelId }));
}

async function enrichYouTubeChannelViaWire(channelId, ctx = {}) {
  const wire = await runWireAction('yt_channel', { channel_id: channelId }, ctx);
  const d = wire.data?.data ?? wire.data;
  if (!d || typeof d !== 'object') return null;

  const profileUrl = d.url || `https://www.youtube.com/channel/${channelId}`;
  const handle = parseYouTubeHandleFromUrl(profileUrl) || channelId;

  let followerCount = null;
  let followerText = null;
  let followerCountSource = null;

  if (subscriberScrapeEnabled() && profileUrl) {
    try {
      const scrape = await scrapeMarkdown(profileUrl, { useBrowser: true, generateJson: false });
      recordApi(ctx.apisUsed, 'POST /v1/url-scraper#youtube_subscribers');
      recordApi(ctx.apisUsed, 'GET /v1/url-scraper/:jobId');
      const parsed = parseYouTubeSubscriberCount(scrape.markdown);
      if (parsed.count != null) {
        followerCount = parsed.count;
        followerText = parsed.text;
        followerCountSource = 'anakin_url_scraper';
      }
    } catch (err) {
      logDiscovery('youtube_subscriber_scrape_failed', {
        traceId: ctx.traceId,
        channelId,
        message: err.message,
      });
    }
  }

  return {
    channelId,
    handle,
    displayName: d.name || handle,
    profileUrl,
    evidenceSnippet: String(d.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    sourceUrl: profileUrl,
    followerText,
    followerCount,
    followerCountSource,
    platform: 'youtube',
    avatarUrl: d.avatar || null,
  };
}

async function enrichYouTubeCreators(creators, { concurrency = 3, ctx = {} } = {}) {
  const out = [];
  let i = 0;
  const workers = Math.min(concurrency, creators.length);

  async function worker() {
    while (i < creators.length) {
      const idx = i++;
      const row = creators[idx];
      const channelId =
        row.channelId || (String(row.handle || '').startsWith('UC') ? row.handle : null);
      if (!channelId) {
        out[idx] = row;
        continue;
      }
      try {
        const enriched = await enrichYouTubeChannelViaWire(channelId, ctx);
        out[idx] = enriched ? { ...row, ...enriched } : row;
      } catch (err) {
        console.warn('[anakinWire] yt_channel enrich failed:', channelId, err.message);
        out[idx] = row;
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function mapWireDataToCreators(data, limit = 25, platform = 'instagram', query = {}) {
  if (normalizePlatform(platform) === 'youtube') {
    return mapYouTubeWireToCreators(data, limit, query);
  }
  const found = [];
  collectRecords(data, found);
  const seen = new Set();
  const unique = [];
  for (const c of found) {
    const key = c.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= limit) break;
  }
  return unique;
}

function mapWireDataToRawResults(data, limit = 10) {
  const results = [];
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  let match;
  while ((match = urlRegex.exec(text)) !== null && results.length < limit * 2) {
    const url = match[0].replace(/[.,;:)]+$/, '');
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: url.slice(0, 120),
      url,
      snippet: text.slice(Math.max(0, match.index - 40), match.index + 120).replace(/\s+/g, ' ').slice(0, 320),
    });
  }
  return results.slice(0, limit);
}

async function searchCreatorsViaWire(query, ctx = {}) {
  const platform = normalizePlatform(query.platform);
  const actionId = await resolveWireActionId(query);
  const params = buildWireParams(query);
  const wire = await runWireAction(actionId, params, ctx);
  const creators = mapWireDataToCreators(wire.data, query.limit ?? 10, platform, query);
  const rawResults =
    creators.length > 0
      ? creators.map((c) => ({
          title: c.displayName,
          url: c.profileUrl || c.sourceUrl,
          snippet: c.evidenceSnippet || c.followerText || '',
        }))
      : mapWireDataToRawResults(wire.data, query.limit ?? 10);

  return {
    requestId: wire.jobId,
    rawResults,
    wireCreators: creators,
    wirePayload: wire,
    prompt: buildDiscoveryQuery({ ...query, platform }),
    actionId: wire.actionId,
    wireParams: params,
    platform,
    source: 'anakin-wire',
  };
}

/** @deprecated use searchCreatorsViaWire */
const searchInstagramCreatorsViaWire = (query) =>
  searchCreatorsViaWire({ ...query, platform: query.platform || 'instagram' });

module.exports = {
  holocronSearch,
  resolveWireActionId,
  runWireAction,
  buildWireParams,
  buildDiscoveryQuery,
  normalizePlatform,
  mapWireDataToCreators,
  mapYouTubeWireToCreators,
  scoreYouTubeVideo,
  enrichYouTubeCreators,
  enrichYouTubeChannelViaWire,
  parseYouTubeHandleFromUrl,
  buildYouTubeWireSearchQuery,
  mapWireDataToRawResults,
  searchCreatorsViaWire,
  searchInstagramCreatorsViaWire,
  extractCreatorFromRecord,
  subscriberScrapeEnabled,
  urlHostMatchesPlatform,
};
