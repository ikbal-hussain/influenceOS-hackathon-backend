const express = require('express');
const { runDiscoveryPipeline } = require('../services/discoveryPipeline');

const router = express.Router();

const MAX_FIELD_LENGTH = 120;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const SUPPORTED_PLATFORMS = new Set(['instagram', 'youtube']);

function validateBody(body) {
  const errors = [];
  const niche = typeof body?.niche === 'string' ? body.niche.trim() : '';
  const location = typeof body?.location === 'string' ? body.location.trim() : '';
  const audienceType = typeof body?.audienceType === 'string' ? body.audienceType.trim() : '';
  const platformRaw = typeof body?.platform === 'string' ? body.platform.trim() : 'instagram';
  const platform = platformRaw.toLowerCase() || 'instagram';

  if (!niche) errors.push({ field: 'niche', message: 'Niche is required' });
  for (const [field, value] of Object.entries({ niche, location, audienceType })) {
    if (value.length > MAX_FIELD_LENGTH) {
      errors.push({ field, message: `Must be ${MAX_FIELD_LENGTH} characters or fewer` });
    }
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    errors.push({
      field: 'platform',
      message: 'Supported platforms: instagram, youtube',
    });
  }

  let limit = Number(body?.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  return { errors, query: { niche, location, audienceType, limit, platform } };
}

function handleDiscoveryError(err, res, label) {
  if (err.code === 'ANAKIN_KEY_MISSING') {
    return res.status(503).json({ error: 'Discovery provider not configured' });
  }
  if (err.code === 'GROQ_KEY_MISSING') {
    return res.status(503).json({ error: 'Discovery extraction provider not configured' });
  }
  if (err.code === 'WIRE_ACTION_MISSING') {
    return res.status(503).json({
      error:
        'Wire action not configured. Set ANAKIN_WIRE_ACTION_ID_YOUTUBE / _INSTAGRAM or ANAKIN_WIRE_ACTION_ID in .env',
      stage: err.stage || 'anakin-wire',
    });
  }
  if (err.code === 'WIRE_AUTH_REQUIRED') {
    return res.status(502).json({
      error: 'Selected Wire action requires account authentication in the Anakin dashboard',
      stage: err.stage || 'anakin-wire',
      actionId: err.actionId ?? null,
    });
  }
  if (err.code === 'WIRE_INSUFFICIENT_CREDITS') {
    return res.status(402).json({
      error: 'Insufficient Anakin credits for Wire action',
      stage: err.stage || 'anakin-wire',
    });
  }

  const stage = err.stage || 'unknown';
  const status = err.response?.status;
  const upstreamBody = err.response?.data;
  const upstreamSnippet =
    typeof upstreamBody === 'string'
      ? upstreamBody.slice(0, 300)
      : upstreamBody
        ? JSON.stringify(upstreamBody).slice(0, 300)
        : null;

  console.error(
    `[discovery/${label}] stage=${stage} status=${status ?? 'n/a'} message=${err.message} upstream=${upstreamSnippet ?? 'n/a'}`,
  );

  if (status === 401 || status === 403) {
    return res.status(502).json({
      error: 'Discovery provider rejected the request',
      stage,
      upstreamStatus: status,
    });
  }
  if (status === 429) {
    return res.status(429).json({
      error: 'Discovery provider rate limit reached, try again shortly',
      stage,
    });
  }

  return res.status(502).json({
    error: 'Failed to fetch creators from discovery provider',
    stage,
    upstreamStatus: status ?? null,
  });
}

async function runDiscovery(req, res, defaultPlatform) {
  const { errors, query } = validateBody(req.body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid request', details: errors });
  }

  const platform = query.platform || defaultPlatform;

  try {
    const { influencers, requestId, prompt, stages } = await runDiscoveryPipeline({
      ...query,
      platform,
    });

    res.json({
      query: { ...query, platform },
      requestId,
      prompt,
      stages,
      count: influencers.length,
      influencers,
    });
  } catch (err) {
    return handleDiscoveryError(err, res, platform);
  }
}

router.post('/instagram', (req, res) => runDiscovery(req, res, 'instagram'));
router.post('/youtube', (req, res) => runDiscovery(req, res, 'youtube'));

module.exports = router;
