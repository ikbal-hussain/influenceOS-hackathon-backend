require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const k = process.env.ANAKIN_API_KEY;
const H = {
  headers: { 'X-API-Key': k, 'Content-Type': 'application/json' },
  timeout: 20000,
  validateStatus: () => true,
};

(async () => {
  console.log('Key prefix:', k ? k.slice(0, 6) + '...' + k.slice(-4) : 'MISSING');

  console.log('\n=== 1) Probe alternate search-like endpoints ===');
  const endpoints = [
    { m: 'POST', p: '/v1/web-search', body: { query: 'top instagram fitness creators', limit: 3 } },
    { m: 'POST', p: '/v1/google',     body: { query: 'top instagram fitness creators', limit: 3 } },
    { m: 'POST', p: '/v1/serp',       body: { query: 'top instagram fitness creators', limit: 3 } },
    { m: 'POST', p: '/v1/research',   body: { query: 'top instagram fitness creators' } },
    { m: 'POST', p: '/v1/discover',   body: { query: 'top instagram fitness creators' } },
    { m: 'POST', p: '/v1/answer',     body: { query: 'top instagram fitness creators' } },
    { m: 'POST', p: '/v1/ask',        body: { query: 'top instagram fitness creators' } },
    { m: 'POST', p: '/v1/perplexity', body: { query: 'top instagram fitness creators' } },
    { m: 'GET',  p: '/v1' },
    { m: 'GET',  p: '/' },
    { m: 'GET',  p: '/openapi.json' },
    { m: 'GET',  p: '/docs' },
  ];
  for (const e of endpoints) {
    try {
      const r = e.m === 'GET'
        ? await axios.get('https://api.anakin.io' + e.p, H)
        : await axios.post('https://api.anakin.io' + e.p, e.body, H);
      const b = typeof r.data === 'string' ? r.data.slice(0, 120) : JSON.stringify(r.data).slice(0, 200);
      console.log(e.m + ' ' + e.p + ' -> ' + r.status + ' ' + b);
    } catch (err) {
      console.log(e.m + ' ' + e.p + ' -> err ' + err.message);
    }
  }

  console.log('\n=== 2) Holocron catalog full listing ===');
  const cat = await axios.get('https://api.anakin.io/v1/holocron/catalog', H);
  console.log('top-level keys:', Object.keys(cat.data || {}).slice(0, 10));
  const items = cat.data?.catalogs || cat.data?.items || cat.data?.results || (Array.isArray(cat.data) ? cat.data : []);
  console.log('catalog count:', Array.isArray(items) ? items.length : 'n/a');
  if (Array.isArray(items)) {
    const looksRelevant = items.filter((x) =>
      /reddit|google|web|search|serp|perplexity|youtube|twitter|tiktok|instagram|profile|creator|scrape/i.test(
        JSON.stringify(x),
      ),
    );
    console.log('relevant catalogs:', looksRelevant.length);
    for (const c of looksRelevant.slice(0, 12)) {
      console.log(' -', c.slug || c.id, '|', c.name, '|', c.action_count, 'actions');
    }
  }

  console.log('\n=== 3) Holocron search for action keywords ===');
  for (const q of ['google', 'web', 'serp', 'reddit', 'youtube', 'tiktok', 'profile', 'creator', 'influencer']) {
    try {
      const r = await axios.get('https://api.anakin.io/v1/holocron/search?q=' + encodeURIComponent(q), H);
      const acts = r.data?.actions || r.data?.results || (Array.isArray(r.data) ? r.data : []);
      console.log('q=' + q + ' status=' + r.status + ' count=' + (Array.isArray(acts) ? acts.length : 'n/a'));
      if (Array.isArray(acts) && acts.length) {
        for (const a of acts.slice(0, 4)) {
          console.log('     ', a.action_id || a.id || a.slug, '|', a.name || a.title);
        }
      }
    } catch (err) {
      console.log('q=' + q + ' err ' + err.message);
    }
  }
})();
