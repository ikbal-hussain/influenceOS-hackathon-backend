/**
 * Optional API-key gate. When the env var is unset/empty, the middleware is a no-op.
 */

function readBearerToken(authorization) {
  if (typeof authorization !== 'string') return '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

/**
 * @param {string} envVarName e.g. ENRICHMENT_API_KEY
 * @param {{ headerNames?: string[], code?: string }} [options]
 */
function requireApiKey(envVarName, options = {}) {
  const headerNames = options.headerNames ?? ['x-api-key'];
  const code = options.code ?? 'UNAUTHORIZED';

  return function apiKeyAuthMiddleware(req, res, next) {
    const expected = process.env[envVarName];
    if (!expected || !String(expected).trim()) {
      return next();
    }

    const expectedTrimmed = String(expected).trim();
    let provided = readBearerToken(req.headers.authorization);

    if (!provided) {
      for (const name of headerNames) {
        const value = req.headers[name];
        if (typeof value === 'string' && value.trim()) {
          provided = value.trim();
          break;
        }
      }
    }

    if (!provided || provided !== expectedTrimmed) {
      return res.status(401).json({
        error: 'Unauthorized',
        code,
        hint: 'Send the configured API key in X-Api-Key, X-Enrichment-Key, or Authorization: Bearer.',
      });
    }

    return next();
  };
}

module.exports = {
  requireApiKey,
};
