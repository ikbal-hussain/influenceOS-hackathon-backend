const express = require('express');
const { runDiscoveryPipeline } = require('../services/discoveryPipeline');

const router = express.Router();

const MAX_FIELD_LENGTH = 120;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function validateBody(body) {
  const errors = [];
  const niche = typeof body?.niche === 'string' ? body.niche.trim() : '';
  const location = typeof body?.location === 'string' ? body.location.trim() : '';
  const audienceType = typeof body?.audienceType === 'string' ? body.audienceType.trim() : '';
  const platform = typeof body?.platform === 'string' ? body.platform.trim() : '';

  if (!niche) errors.push({ field: 'niche', message: 'Niche is required' });
  for (const [field, value] of Object.entries({ niche, location, audienceType })) {
    if (value.length > MAX_FIELD_LENGTH) {
      errors.push({ field, message: `Must be ${MAX_FIELD_LENGTH} characters or fewer` });
    }
  }
  if (platform && platform.toLowerCase() !== 'instagram') {
    errors.push({
      field: 'platform',
      message: 'Only Instagram is supported in this version',
    });
  }

  let limit = Number(body?.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  return { errors, query: { niche, location, audienceType, limit } };
}

router.post('/instagram', async (req, res) => {
  const { errors, query } = validateBody(req.body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid request', details: errors });
  }

  try {
    const { influencers, requestId, prompt, stages } = await runDiscoveryPipeline(query);

    res.json({
      query: { ...query, platform: 'instagram' },
      requestId,
      prompt,
      stages,
      count: influencers.length,
      influencers,
    });
  } catch (err) {
    if (err.code === 'ANAKIN_KEY_MISSING') {
      return res.status(503).json({ error: 'Discovery provider not configured' });
    }
    if (err.code === 'GROQ_KEY_MISSING') {
      return res.status(503).json({ error: 'Discovery extraction provider not configured' });
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
      `[discovery/instagram] stage=${stage} status=${status ?? 'n/a'} message=${err.message} upstream=${upstreamSnippet ?? 'n/a'}`,
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
});

module.exports = router;
