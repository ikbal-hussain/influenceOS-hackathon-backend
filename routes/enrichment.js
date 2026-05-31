const express = require('express');
const axios = require('axios');
const { requireApiKey } = require('../middleware/apiKeyAuth');
const {
  fetchInstagramProfileRaw,
  normalizeProfile,
  getToken,
  ACTOR_ID,
} = require('../services/apifyInstagramProfile');

const router = express.Router();

const requireEnrichmentApiKey = requireApiKey('ENRICHMENT_API_KEY', {
  headerNames: ['x-enrichment-key', 'x-api-key'],
  code: 'ENRICHMENT_UNAUTHORIZED',
});

const IMAGE_HOST_ALLOWLIST = [
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
];

function isAllowedImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return IMAGE_HOST_ALLOWLIST.some((host) => (
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    ));
  } catch {
    return false;
  }
}

router.get('/instagram/profile-picture', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || !isAllowedImageUrl(imageUrl)) {
    return res.status(400).json({ error: 'Invalid profile image URL' });
  }

  try {
    const upstream = await axios.get(imageUrl, {
      responseType: 'stream',
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://www.instagram.com/',
      },
    });

    const contentType = String(upstream.headers['content-type'] || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      upstream.data.destroy?.();
      return res.status(502).json({ error: 'Upstream response is not an image' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    upstream.data.on('error', (streamErr) => {
      console.error('[enrichment/profile-picture] stream', streamErr.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Could not load profile image' });
      } else {
        res.end();
      }
    });
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[enrichment/profile-picture]', err.message);
    return res.status(502).json({ error: 'Could not load profile image' });
  }
});

router.get('/instagram/:username', requireEnrichmentApiKey, async (req, res) => {
  const rawUsername = req.params.username;

  try {
    if (!getToken()) {
      return res.status(503).json({
        error: 'Live profile enrichment is not configured on the server',
        code: 'APIFY_NOT_CONFIGURED',
        hint: 'Add APIFY_API_TOKEN to the backend .env — see InfluenceOS-backend README.',
      });
    }

    const raw = await fetchInstagramProfileRaw(rawUsername);
    if (!raw) {
      return res.status(404).json({
        error: 'No profile data returned for this username',
        code: 'NO_DATA',
      });
    }

    const profile = normalizeProfile(raw);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({
      source: 'apify',
      actorId: ACTOR_ID,
      profile,
      raw: process.env.APIFY_RETURN_RAW === 'true' ? raw : undefined,
    });
  } catch (err) {
    if (err.code === 'INVALID_USERNAME') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === 'APIFY_TIMEOUT') {
      return res.status(504).json({
        error: 'Live profile request timed out. Try again later.',
        code: err.code,
      });
    }
    if (err.code === 'APIFY_NOT_CONFIGURED') {
      return res.status(503).json({
        error: err.message,
        code: err.code,
      });
    }

    console.error('[enrichment/instagram]', err.message);
    return res.status(502).json({
      error: 'Could not load live profile. Try again later.',
      code: 'APIFY_ERROR',
    });
  }
});

module.exports = router;
