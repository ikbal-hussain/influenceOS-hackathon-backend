/**
 * In-memory sliding-window rate limiter (per key, typically client IP).
 * Resets on process restart; suitable for single-instance deployments.
 */

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {{ windowMs?: number, max?: number, keyPrefix?: string }} [options]
 */
function createRateLimiter(options = {}) {
  const windowMs = parsePositiveInt(options.windowMs, 60_000);
  const max = parsePositiveInt(options.max, 60);
  const keyPrefix = options.keyPrefix ? `${options.keyPrefix}:` : '';
  const buckets = new Map();

  function prune() {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    prune();
    const ip = getClientIp(req);
    const bucketKey = `${keyPrefix}${ip}`;
    const now = Date.now();
    let entry = buckets.get(bucketKey);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        retryAfterSeconds: retryAfterSec,
      });
    }

    return next();
  };
}

module.exports = {
  createRateLimiter,
  getClientIp,
};
