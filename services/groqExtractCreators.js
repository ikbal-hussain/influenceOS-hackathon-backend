const axios = require('axios');
const { logDiscovery } = require('./discoveryLog');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const MAX_TOTAL_CHARS = 24_000;
const MAX_BLOCK_CHARS = 6_000;
/** Prefer Anakin generatedJson.data stringified over raw markdown when present */
const MAX_JSON_BLOCK_CHARS = 4_000;
const INSTAGRAM_HANDLE_REGEX = /^[A-Za-z0-9_.]{1,30}$/;
const YOUTUBE_HANDLE_REGEX = /^[A-Za-z0-9._-]{3,30}$/;
const YOUTUBE_CHANNEL_ID_REGEX = /^UC[\w-]{10,}$/;

function getConfig() {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  return { apiKey, model };
}

/** Resolved Groq model id (for logs and API `stages`); no secrets. */
function getGroqModelId() {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

/**
 * Normalize Anakin URL-scraper `generatedJson` ({ status, data } per OSS docs).
 */
function structuredPayloadFromGeneratedJson(generatedJson) {
  if (!generatedJson || typeof generatedJson !== 'object') return null;
  if (generatedJson.status === 'failed') return null;
  const data = generatedJson.data;
  if (data != null && typeof data === 'object') return data;
  if (generatedJson.status === 'success') return null;
  return null;
}

function buildWireSourceBlock(wirePayload) {
  if (!wirePayload?.data) return '';
  const actionId = wirePayload.actionId || 'wire';
  const jsonStr = JSON.stringify(wirePayload.data);
  const body = truncate(jsonStr, MAX_JSON_BLOCK_CHARS);
  return [
    '### SOURCE (Anakin Wire / Holocron)',
    `WIRE_ACTION: ${actionId}`,
    `STRUCTURED_JSON:\n${body}`,
  ].join('\n');
}

function buildSourceBlocks(searchResults, scrapedArticles, wirePayload) {
  const scrapedByUrl = new Map(
    (scrapedArticles || []).map((a) => [a.url, a]),
  );

  const blocks = [];
  let used = 0;

  const wireBlock = buildWireSourceBlock(wirePayload);
  if (wireBlock) {
    blocks.push(wireBlock);
    used += wireBlock.length;
  }

  for (const r of searchResults || []) {
    if (used >= MAX_TOTAL_CHARS) break;
    const url = r?.url || '';
    const title = r?.title || '';
    const snippet = r?.snippet || '';
    const row = scrapedByUrl.get(url);
    const markdown = row?.markdown || '';
    const structured = structuredPayloadFromGeneratedJson(row?.generatedJson);

    const remaining = MAX_TOTAL_CHARS - used;
    const blockBudget = Math.min(MAX_BLOCK_CHARS, remaining);

    let body = '';
    if (structured != null) {
      const jsonStr = JSON.stringify(structured);
      body = truncate(jsonStr, Math.min(blockBudget - 120, MAX_JSON_BLOCK_CHARS));
      body = `STRUCTURED_JSON:\n${body}`;
    } else if (markdown) {
      body = truncate(markdown, blockBudget - title.length - snippet.length - url.length - 80);
    } else {
      body = snippet;
    }

    const block = [
      `### SOURCE`,
      `URL: ${url}`,
      title ? `TITLE: ${title}` : null,
      snippet ? `SNIPPET: ${snippet}` : null,
      body ? `CONTENT:\n${body}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    blocks.push(block);
    used += block.length;
  }

  return blocks.join('\n\n');
}

function isYouTubeQuery(query) {
  return String(query?.platform || '').toLowerCase() === 'youtube';
}

function buildMessages({ query, sources, limit }) {
  const youtube = isYouTubeQuery(query);

  const system = youtube
    ? [
        'You are an extraction assistant for a YouTube influencer-discovery tool.',
        'Read the SOURCES (Anakin Wire JSON from YouTube search). Return real YouTube CREATOR channels in the brief niche.',
        'Rules:',
        '1. Output valid JSON only. No markdown.',
        '2. Include only channels that create content in the niche (fitness, beauty, etc.) — NOT commentary channels that only rank/expose/roast other creators.',
        '3. Each creator needs channelId (UC…) from SOURCES when present, and handle as the @username without @ when known.',
        '4. Prefer channels whose name/title clearly match the niche and location in the brief.',
        '5. Deduplicate by channelId. Max N creators as requested.',
        '6. evidenceSnippet: short proof from video title or channel name in SOURCES.',
        '7. sourceUrl: a youtube.com URL from SOURCES for that channel/video.',
        '',
        'JSON schema:',
        '{ "creators": [ { "handle": string, "channelId": string|null, "displayName": string|null, "followerText": string|null, "evidenceSnippet": string, "sourceUrl": string } ] }',
      ].join('\n')
    : [
        'You are an extraction assistant for an influencer-discovery tool.',
        'Your job: read the SOURCES (article snippets, optional STRUCTURED_JSON from Anakin, and markdown) and return a JSON object',
        'listing real Instagram creators that the SOURCES explicitly mention.',
        'You MUST follow these rules:',
        '1. Output valid JSON only, matching the schema below. No prose, no markdown.',
        '2. NEVER invent a handle. If the handle does not literally appear in the SOURCES (as @handle, instagram.com/handle, or "username: handle"), omit that creator.',
        '3. Each handle must match the regex ^[A-Za-z0-9_.]{1,30}$ (Instagram username rules).',
        '4. Prefer creators that match the brief (niche/location/audience) when ranking.',
        '5. Deduplicate by handle (case-insensitive). Maximum N creators where N is provided in the user message.',
        '6. followerText is the verbatim follower string you saw in the source (e.g. "1.2M followers"), or null if not present.',
        '7. evidenceSnippet is a <=240 char excerpt from the SOURCES that proves the creator was mentioned.',
        '8. sourceUrl must be one of the URLs from the SOURCES.',
        '',
        'JSON schema:',
        '{ "creators": [ { "handle": string, "displayName": string|null, "followerText": string|null, "evidenceSnippet": string, "sourceUrl": string } ] }',
      ].join('\n');

  const briefLines = [
    `Niche: ${query.niche || '(unspecified)'}`,
    query.location ? `Location: ${query.location}` : null,
    query.audienceType ? `Audience: ${query.audienceType}` : null,
  ].filter(Boolean);

  const user = [
    `BRIEF`,
    briefLines.join('\n'),
    '',
    `Return at most ${limit} creators in the "creators" array.`,
    '',
    'SOURCES',
    sources || '(none)',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function parseGroqResponse(rawContent, { platform } = {}) {
  if (!rawContent) return [];
  let text = String(rawContent).trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
  }

  const youtube = String(platform || '').toLowerCase() === 'youtube';
  const creators = Array.isArray(parsed?.creators) ? parsed.creators : [];
  return creators
    .map((c) => {
      const rawHandle = typeof c?.handle === 'string' ? c.handle.replace(/^@/, '').trim() : '';
      const channelId =
        typeof c?.channelId === 'string' && YOUTUBE_CHANNEL_ID_REGEX.test(c.channelId.trim())
          ? c.channelId.trim()
          : YOUTUBE_CHANNEL_ID_REGEX.test(rawHandle)
            ? rawHandle
            : null;

      if (youtube) {
        const handleOk = YOUTUBE_HANDLE_REGEX.test(rawHandle);
        if (!handleOk && !channelId) return null;
        return {
          handle: handleOk ? rawHandle : channelId,
          channelId,
          displayName: typeof c?.displayName === 'string' ? c.displayName.trim() : null,
          followerText: typeof c?.followerText === 'string' ? c.followerText.trim() : null,
          evidenceSnippet:
            typeof c?.evidenceSnippet === 'string' ? c.evidenceSnippet.trim().slice(0, 240) : '',
          sourceUrl: typeof c?.sourceUrl === 'string' ? c.sourceUrl.trim() : '',
          platform: 'youtube',
        };
      }

      if (!INSTAGRAM_HANDLE_REGEX.test(rawHandle)) return null;
      return {
        handle: rawHandle,
        displayName: typeof c?.displayName === 'string' ? c.displayName.trim() : null,
        followerText: typeof c?.followerText === 'string' ? c.followerText.trim() : null,
        evidenceSnippet:
          typeof c?.evidenceSnippet === 'string' ? c.evidenceSnippet.trim().slice(0, 240) : '',
        sourceUrl: typeof c?.sourceUrl === 'string' ? c.sourceUrl.trim() : '',
      };
    })
    .filter(Boolean);
}

function dedupeByHandle(creators) {
  const seen = new Map();
  for (const c of creators) {
    const key = (c.channelId || c.handle || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.set(key, c);
  }
  return Array.from(seen.values());
}

async function extractCreators({ query, searchResults, scrapedArticles, wirePayload, limit }) {
  const { apiKey, model } = getConfig();
  const resolvedModel = getGroqModelId();

  if (!apiKey) {
    const err = new Error('Groq API key is not configured');
    err.code = 'GROQ_KEY_MISSING';
    throw err;
  }

  const sources = buildSourceBlocks(searchResults, scrapedArticles, wirePayload);
  if (!sources) {
    logDiscovery('llm_skipped', {
      llmProvider: 'groq',
      llmModel: resolvedModel,
      reason: 'no_sources',
    });
    return {
      creators: [],
      meta: { llmInvoked: false, llmProvider: 'groq', llmModel: resolvedModel, reason: 'no_sources' },
    };
  }

  logDiscovery('llm_attempt', {
    llmProvider: 'groq',
    llmModel: resolvedModel,
    sourcesChars: sources.length,
    groqHost: 'api.groq.com',
  });

  const messages = buildMessages({ query, sources, limit });
  const platform = query?.platform;

  const response = await axios.post(
    GROQ_URL,
    {
      model,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: 1200,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    },
  );

  const content = response.data?.choices?.[0]?.message?.content || '';
  const creators = dedupeByHandle(parseGroqResponse(content, { platform }));
  logDiscovery('llm_result', {
    llmProvider: 'groq',
    llmModel: resolvedModel,
    creatorCount: creators.length,
  });
  return {
    creators,
    meta: { llmInvoked: true, llmProvider: 'groq', llmModel: resolvedModel },
  };
}

module.exports = {
  extractCreators,
  parseGroqResponse,
  dedupeByHandle,
  buildSourceBlocks,
  buildWireSourceBlock,
  structuredPayloadFromGeneratedJson,
  getGroqModelId,
};
