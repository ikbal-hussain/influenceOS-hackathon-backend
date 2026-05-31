const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { createRateLimiter } = require('../middleware/rateLimit');
const { requireApiKey } = require('../middleware/apiKeyAuth');
const {
  normalizeUsername,
  clearProfileCache,
  fetchInstagramProfileRaw,
} = require('../services/apifyInstagramProfile');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

async function request(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // ignore
  }
  return { status: res.status, body, headers: res.headers };
}

test('requireApiKey is a no-op when env var is unset', async () => {
  const prev = process.env.ENRICHMENT_API_KEY;
  delete process.env.ENRICHMENT_API_KEY;

  const app = express();
  app.get('/protected', requireApiKey('ENRICHMENT_API_KEY'), (req, res) => {
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const res = await request(baseUrl, '/protected');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    server.close();
    if (prev !== undefined) process.env.ENRICHMENT_API_KEY = prev;
  }
});

test('requireApiKey rejects missing or wrong key', async () => {
  const prev = process.env.ENRICHMENT_API_KEY;
  process.env.ENRICHMENT_API_KEY = 'test-secret-key';

  const app = express();
  app.get(
    '/protected',
    requireApiKey('ENRICHMENT_API_KEY', { headerNames: ['x-enrichment-key'] }),
    (req, res) => res.json({ ok: true }),
  );

  const { server, baseUrl } = await listen(app);
  try {
    const missing = await request(baseUrl, '/protected');
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, 'UNAUTHORIZED');

    const wrong = await request(baseUrl, '/protected', {
      headers: { 'X-Enrichment-Key': 'wrong' },
    });
    assert.equal(wrong.status, 401);

    const ok = await request(baseUrl, '/protected', {
      headers: { 'X-Enrichment-Key': 'test-secret-key' },
    });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
    if (prev !== undefined) process.env.ENRICHMENT_API_KEY = prev;
    else delete process.env.ENRICHMENT_API_KEY;
  }
});

test('createRateLimiter returns 429 after max requests', async () => {
  const app = express();
  app.use(
    createRateLimiter({ windowMs: 60_000, max: 2, keyPrefix: 'test' }),
  );
  app.get('/limited', (req, res) => res.json({ ok: true }));

  const { server, baseUrl } = await listen(app);
  try {
    assert.equal((await request(baseUrl, '/limited')).status, 200);
    assert.equal((await request(baseUrl, '/limited')).status, 200);
    const blocked = await request(baseUrl, '/limited');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'RATE_LIMITED');
  } finally {
    server.close();
  }
});

test('normalizeUsername lowercases and strips @', () => {
  assert.equal(normalizeUsername('@Fitness_Guru'), 'fitness_guru');
});

test('fetchInstagramProfileRaw rejects invalid usernames without calling Apify', async () => {
  clearProfileCache();
  await assert.rejects(
    () => fetchInstagramProfileRaw('not valid!'),
    (err) => err.code === 'INVALID_USERNAME',
  );
});
