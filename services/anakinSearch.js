const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.anakin.io/v1';

function getConfig() {
  const apiKey = process.env.ANAKIN_API_KEY;
  const baseUrl = (process.env.ANAKIN_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return { apiKey, baseUrl };
}

function buildInstagramPrompt({ niche, location, audienceType }) {
  const parts = [
    'Find articles, roundups, and listicles that name multiple real Instagram creators',
    niche ? `in the ${niche} niche` : null,
    location ? `based in or relevant to ${location}` : null,
    audienceType ? `for audiences such as ${audienceType}` : null,
    'Prefer pages that explicitly mention Instagram handles (e.g. @username or instagram.com/username) and follower counts.',
    'Favour micro and mid-tier creators (10k-500k followers) over mega celebrities when possible.',
    'Skip generic news pages, brand homepages, and pure marketplace listings.',
  ].filter(Boolean);
  return parts.join(' ');
}

async function searchInstagramCreators({ niche, location, audienceType, limit = 10 }) {
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    const err = new Error('Anakin API key is not configured');
    err.code = 'ANAKIN_KEY_MISSING';
    throw err;
  }

  const prompt = buildInstagramPrompt({ niche, location, audienceType });

  const response = await axios.post(
    `${baseUrl}/search`,
    { prompt, limit },
    {
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    },
  );

  return {
    requestId: response.data?.id ?? null,
    rawResults: Array.isArray(response.data?.results) ? response.data.results : [],
    prompt,
  };
}

module.exports = {
  searchInstagramCreators,
  buildInstagramPrompt,
};
