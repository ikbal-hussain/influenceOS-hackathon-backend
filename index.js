require('dotenv').config();

const express = require('express');
const cors = require('cors');
const discoveryRouter = require('./routes/discovery');
const enrichmentRouter = require('./routes/enrichment');
const { createRateLimiter } = require('./middleware/rateLimit');
const { requireApiKey } = require('./middleware/apiKeyAuth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

const globalRateLimit = createRateLimiter({
  windowMs: process.env.RATE_LIMIT_WINDOW_MS,
  max: process.env.RATE_LIMIT_MAX,
  keyPrefix: 'global',
});

const discoveryRateLimit = createRateLimiter({
  windowMs: process.env.DISCOVERY_RATE_LIMIT_WINDOW_MS,
  max: process.env.DISCOVERY_RATE_LIMIT_MAX,
  keyPrefix: 'discovery',
});

const enrichmentRateLimit = createRateLimiter({
  windowMs: process.env.ENRICHMENT_RATE_LIMIT_WINDOW_MS,
  max: process.env.ENRICHMENT_RATE_LIMIT_MAX,
  keyPrefix: 'enrichment',
});

/** Comma-separated extra origins in CLIENT_ORIGIN are merged with these defaults */
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'https://influenceos-app.netlify.app',
];

/** Any Vite/webpack port on loopback (incl. `[::1]`) when the SPA calls the API on :3000 */
function isLoopbackHttpOrigin(origin) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const { hostname } = url;
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function allowedOriginsList() {
  const raw = process.env.CLIENT_ORIGIN;
  const fromEnv =
    raw && raw.trim()
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  return [...new Set([...DEFAULT_ORIGINS, ...fromEnv])];
}

const allowedOrigins = allowedOriginsList();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (process.env.NODE_ENV !== 'production' && isLoopbackHttpOrigin(origin)) {
        return callback(null, origin);
      }
      callback(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(globalRateLimit);

app.get('/', (req, res) => {
  res.json({
    name: 'influenceos-backend',
    health: '/health',
    endpoints: [
      'POST /api/v1/discovery/instagram',
      'GET /api/v1/enrichment/instagram/:username',
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use(
  '/api/v1/discovery',
  discoveryRateLimit,
  requireApiKey('DISCOVERY_API_KEY', { headerNames: ['x-api-key'], code: 'DISCOVERY_UNAUTHORIZED' }),
  discoveryRouter,
);
app.use('/api/v1/enrichment', enrichmentRateLimit, enrichmentRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
