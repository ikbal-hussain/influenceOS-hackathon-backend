const { scrapeMarkdown } = require('./anakinUrlScraper');

const DDG_HTML_BASE = 'https://html.duckduckgo.com/html/';

function buildSearchQuery({ niche, location, audienceType }) {
  const parts = [
    'top instagram',
    niche || 'creators',
    'influencers',
    location ? `in ${location}` : null,
    audienceType ? `for ${audienceType}` : null,
    'list',
  ].filter(Boolean);
  return parts.join(' ');
}

function buildSerpUrl(query) {
  return `${DDG_HTML_BASE}?q=${encodeURIComponent(query)}`;
}

function decodeDuckDuckGoRedirect(href) {
  try {
    const url = new URL(href);
    if (!/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return href;
    const target = url.searchParams.get('uddg');
    if (!target) return href;
    return decodeURIComponent(target);
  } catch {
    return href;
  }
}

function isResultLink(rawHref) {
  if (!rawHref) return false;
  if (!/^https?:\/\//i.test(rawHref)) return false;
  if (/duckduckgo\.com\/(?!l\/)/i.test(rawHref)) return false;
  if (/y\.js|d\.js|\?\.\.\.|safe-search/i.test(rawHref)) return false;
  return true;
}

function dedupeByUrl(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = (r.url || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function cleanSnippet(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\\([_*~])/g, '$1')
    .trim()
    .slice(0, 320);
}

function isLikelyTitle(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^www\./i.test(trimmed)) return false;
  return true;
}

function parseDuckDuckGoMarkdown(markdown, { limit = 10 } = {}) {
  if (!markdown || typeof markdown !== 'string') return [];

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const found = [];
  let match;
  while ((match = linkRegex.exec(markdown)) !== null) {
    const title = match[1].trim();
    const decoded = decodeDuckDuckGoRedirect(match[2]);
    if (!isResultLink(decoded)) continue;
    if (!isLikelyTitle(title)) continue;

    const matchEnd = match.index + match[0].length;
    const after = markdown.slice(matchEnd, matchEnd + 600);
    const snippetCandidates = after
      .split(/\n+/)
      .map((line) => cleanSnippet(line))
      .filter((line) => line.length >= 30 && !/^https?:\/\//i.test(line) && !/^www\./i.test(line));

    found.push({
      title,
      url: decoded,
      snippet: snippetCandidates[0] || '',
    });
  }

  return dedupeByUrl(found).slice(0, limit);
}

async function searchInstagramCreatorsViaScraper({
  niche,
  location,
  audienceType,
  limit = 10,
} = {}) {
  const query = buildSearchQuery({ niche, location, audienceType });
  const serpUrl = buildSerpUrl(query);

  const scrape = await scrapeMarkdown(serpUrl, { useBrowser: false, generateJson: false });
  const results = parseDuckDuckGoMarkdown(scrape.markdown, { limit });

  return {
    requestId: scrape.jobId || null,
    rawResults: results,
    prompt: query,
    serpUrl,
    source: 'anakin-url-scraper-serp',
  };
}

module.exports = {
  searchInstagramCreatorsViaScraper,
  buildSearchQuery,
  buildSerpUrl,
  parseDuckDuckGoMarkdown,
  decodeDuckDuckGoRedirect,
};
