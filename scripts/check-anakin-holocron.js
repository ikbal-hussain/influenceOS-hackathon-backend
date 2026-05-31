/**
 * Quick check: can we use Anakin.io Wire (Holocron) for Instagram-style discovery?
 * Loads ANAKIN_API_KEY from .env (never print the key).
 *
 * Usage: node scripts/check-anakin-holocron.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = (process.env.ANAKIN_API_BASE_URL || 'https://api.anakin.io/v1').replace(
  /\/$/,
  '',
);

async function tryGet(path, label) {
  const url = `${BASE}${path}`;
  const key = process.env.ANAKIN_API_KEY;
  if (!key) {
    console.error('Missing ANAKIN_API_KEY in .env');
    process.exit(1);
  }

  const res = await fetch(url, {
    headers: { 'X-API-Key': key },
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null
  }

  console.log(`\n--- ${label} ---`);
  console.log('URL:', url);
  console.log('HTTP:', res.status);

  if (!json) {
    console.log('Body (first 400 chars):', text.slice(0, 400));
    return { ok: res.ok, json: null };
  }

  if (!res.ok) {
    console.log('Error JSON:', JSON.stringify(json, null, 2).slice(0, 800));
    return { ok: false, json };
  }

  return { ok: true, json };
}

function summarizeHolocronSearch(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  console.log('Actions returned:', results.length);

  const insta = results.filter((r) => {
    const blob = `${r.catalog_slug || ''} ${r.name || ''} ${r.description || ''}`.toLowerCase();
    return blob.includes('insta');
  });

  console.log('Likely Instagram-related:', insta.length);

  const preview = results.slice(0, 8).map((r) => ({
    action_id: r.action_id,
    name: r.name,
    catalog_slug: r.catalog_slug,
    auth_required: r.auth_required,
    credits: r.credits,
    mode: r.mode,
  }));

  console.log('Sample (up to 8):', JSON.stringify(preview, null, 2));

  if (insta.length) {
    console.log('\nInstagram-ish actions (detail):');
    console.log(JSON.stringify(insta.slice(0, 5), null, 2).slice(0, 4000));
  }

  return { total: results.length, instaCount: insta.length };
}

function summarizeCatalog(data) {
  const catalog = Array.isArray(data?.catalog) ? data.catalog : [];
  console.log('Catalogs returned:', catalog.length);

  const social = catalog.filter((c) => {
    const blob = `${c.slug || ''} ${c.name || ''} ${c.category || ''}`.toLowerCase();
    return /insta|tiktok|youtube|social|twitter|x\.com/.test(blob);
  });

  console.log('Social-ish catalogs:', social.length);
  if (social.length) {
    console.log(
      JSON.stringify(
        social.slice(0, 15).map((c) => ({
          slug: c.slug,
          name: c.name,
          category: c.category,
          action_count: c.action_count,
          auth_required: c.auth_required,
        })),
        null,
        2,
      ),
    );
  } else if (catalog.length) {
    console.log(
      'First 10 slugs:',
      catalog.slice(0, 10).map((c) => c.slug),
    );
  }
}

async function main() {
  console.log('Anakin.io Holocron / Wire smoke test');
  console.log('BASE:', BASE);

  const catalogRes = await tryGet('/holocron/catalog', 'GET /holocron/catalog');
  if (catalogRes.ok && catalogRes.json) {
    summarizeCatalog(catalogRes.json);
  }

  const queries = ['instagram', 'insta', 'ig profile', 'social media influencer'];
  let bestSearch = { ok: false, json: null, label: '' };

  for (const q of queries) {
    const path = `/holocron/search?q=${encodeURIComponent(q)}`;
    const r = await tryGet(path, `GET /holocron/search?q=${q}`);
    if (r.ok && r.json) {
      summarizeHolocronSearch(r.json);
      bestSearch = { ok: true, json: r.json, label: q };
      if (r.json?.results?.length) break;
    }
  }

  console.log('\n=== Verdict ===');
  if (!catalogRes.ok) {
    console.log(
      'Catalog call failed — fix ANAKIN_API_KEY (anakin.io scraper key) or network before Wire will work.',
    );
    process.exitCode = 1;
    return;
  }

  const n = bestSearch.json?.results?.length ?? 0;

  if (n === 0) {
    console.log(
      'No Wire actions matched our search queries. Option C may not be viable without browsing the Wire dashboard for an exact action_id.',
    );
  } else {
    console.log(
      `Found ${n} action(s) (best query: "${bestSearch.label}") — inspect auth_required and params above; if one fits your form, Option C can work.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
