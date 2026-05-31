# influenceOS-hackathon-backend

## Anakin Build-a-thon — Wire / Holocron

This backend is built for the **[Anakin Build-a-thon](https://anakin.io/holocron)** requirement: **discovery uses Anakin Wire (Holocron)** by default.

| Setting | Default | Meaning |
|---------|---------|---------|
| `DISCOVERY_WIRE_REQUIRED` | `true` | No fallback to `/v1/search` or DuckDuckGo SERP |
| `DISCOVERY_SEARCH_MODE` | `wire` | Every discovery call runs `POST /holocron/task` |
| `ANAKIN_WIRE_ACTION_ID_YOUTUBE` | `yt_search` | YouTube video/channel search via Wire |
| `ANAKIN_WIRE_ACTION_ID_INSTAGRAM` | `yt_search` | Instagram-oriented query via YouTube Wire + Groq extraction |

Verify Wire: `npm run check:holocron`. Demo **YouTube** in the UI for direct Wire → channel results; **Instagram** uses Wire JSON + Groq for `@handle` extraction.

---

InfluenceOS is an AI-powered influencer discovery platform that helps brands find the right micro-influencers for their campaigns. By analyzing creator profiles, engagement, niche, audience relevance, and web data, it generates smart match scores, campaign insights, and personalized outreach messages, making influencer marketing faster and more data-driven.

This repository contains the Node.js + Express API that powers the [InfluenceOS-hackathon](https://github.com/ikbal-hussain/influenceOS-hackathon) frontend.

## Setup

**Not the legacy repo:** run this project (`influenceOS-hackathon-backend`), not `InfluenceOS-backend`. Both use port **3000** by default; the hackathon frontend proxies to whatever is listening there.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Environment: copy `.env.example` to `.env` and edit if needed.

   - **PowerShell:** `Copy-Item .env.example .env`
   - **macOS / Linux:** `cp .env.example .env`

   Variables:

   - `PORT` — default `3000`.
   - `CLIENT_ORIGIN` — optional comma-separated **extra** origins; merged with built-ins (common Vite ports on localhost / 127.0.0.1, and **any `http://` origin whose host is loopback**).
   - `ANAKIN_API_KEY` — required for `/api/v1/discovery/*` endpoints. Get one from the [Anakin dashboard](https://anakin.io/dashboard); keys start with `ak-`.
   - `ANAKIN_API_BASE_URL` — optional, defaults to `https://api.anakin.io/v1`.
   - `GROQ_API_KEY` — required for the discovery pipeline's JSON extraction stage. Get one from the [Groq console](https://console.groq.com/).
   - `GROQ_MODEL` — optional, defaults to `llama-3.1-8b-instant` (smaller / cheaper TPM vs 70B). Override with e.g. `llama-3.3-70b-versatile` if extraction quality drops. Any Groq chat model that supports `response_format=json_object`.
   - `ANAKIN_WIRE_ACTION_ID` — optional. Holocron / Wire `action_id` from [anakin.io/holocron](https://anakin.io/holocron). When set, `auto` mode tries Wire before search/SERP.
   - `ANAKIN_WIRE_SEARCH_QUERY` — optional. Holocron search to auto-pick an action when `ANAKIN_WIRE_ACTION_ID` is unset (`wire` mode).
   - `ANAKIN_WIRE_PARAMS_JSON` — optional JSON for Wire task params; supports `{{niche}}`, `{{location}}`, `{{audienceType}}`, `{{query}}`, `{{limit}}`.
   - `DISCOVERY_SEARCH_MODE` — optional, default `auto`. Selects the search backend:
     - `auto` — if `ANAKIN_WIRE_ACTION_ID` is set, try Wire first; else try `/v1/search`, then DuckDuckGo SERP via URL Scraper.
     - `wire` — only Holocron Wire (`POST /holocron/task`).
     - `api` — only use Anakin `/v1/search`.
     - `serp` — only DuckDuckGo SERP via URL Scraper.
   - `DISCOVERY_SEARCH_LIMIT` — optional, default `5`. Anakin Search results fetched per query (~3 credits each).
   - `DISCOVERY_ARTICLE_SCRAPE_MAX` — optional, default `3`. Article URLs scraped with Anakin URL Scraper (~1 credit each). Set to `0` to skip and feed Groq only snippets.
   - `DISCOVERY_ANAKIN_GENERATE_JSON` — optional, default `true`. When `true`, article scrapes pass `generateJson: true` to Anakin URL Scraper so each job can return `generatedJson` (structured extraction on Anakin). Groq prompts prefer compact `STRUCTURED_JSON` over full markdown to reduce tokens per minute (TPM). Set `false` for markdown-only scrapes (previous behavior, lower Anakin extraction cost/latency).
   - `DISCOVERY_PROFILE_SCRAPE_MAX` — optional, default `0`. Top-N Instagram profiles to enrich via URL Scraper. Off by default because Instagram blocks anonymous scrapers.
   - `DISCOVERY_GROQ_REQUIRED` — optional, default `true`. When `false`, the endpoint falls back to the legacy snippet-only mapper if Groq is missing or fails.
   - `APIFY_API_TOKEN` — optional. Enables `GET /api/v1/enrichment/instagram/:username` using the Apify actor [`apify/instagram-profile-scraper`](https://apify.com/apify/instagram-profile-scraper). Without it, the frontend detail page still works but shows discovery-only data (503 from enrichment).
   - `APIFY_RETURN_RAW` — optional. Set to `true` to include the raw Apify dataset item in enrichment responses (debug only).
   - `ENRICHMENT_API_KEY` — optional in dev; **recommended in production**. When set, `GET /api/v1/enrichment/instagram/:username` requires `X-Enrichment-Key`, `X-Api-Key`, or `Authorization: Bearer`. Set the same value in the frontend as `VITE_ENRICHMENT_API_KEY` (visible in the bundle — use with rate limits, not as a true secret).
   - `DISCOVERY_API_KEY` — optional. When set, `POST /api/v1/discovery/instagram` requires `X-Api-Key` or `Authorization: Bearer`.
   - Rate limits (per IP, in-memory): `RATE_LIMIT_*` (global), `DISCOVERY_RATE_LIMIT_*`, `ENRICHMENT_RATE_LIMIT_*` — see `.env.example`.
   - `ENRICHMENT_CACHE_TTL_SECONDS` — optional, default `300`. Caches successful Apify profile responses per username to avoid duplicate actor runs.

## Run

- **Development** (auto-restart with nodemon):

  ```bash
  npm run dev
  ```

- **Production**:

  ```bash
  npm start
  ```

Default URL: `http://localhost:3000` (or `PORT` from `.env`).

## Check Anakin.io Wire (Holocron) for Instagram actions

After setting `ANAKIN_API_KEY` from [anakin.io](https://anakin.io/dashboard), run:

```bash
npm run check:holocron
```

This calls `GET /v1/holocron/catalog` and a few `GET /v1/holocron/search` queries (no secrets printed). If you see **HTTP 200** and action rows, Option C (Wire) is plausible; if **401**, the key is not accepted by `api.anakin.io` (regenerate on the scraper dashboard or fix the env value).

## Endpoints

| Method | Path                              | Description                                         |
|--------|-----------------------------------|-----------------------------------------------------|
| GET    | `/`                               | API info                                            |
| GET    | `/health`                         | Health check                                        |
| POST   | `/api/v1/discovery/instagram`     | Discover Instagram creators via Anakin Search API   |
| GET    | `/api/v1/enrichment/instagram/:username` | Live profile via Apify (`APIFY_API_TOKEN` required) |

### `GET /api/v1/enrichment/instagram/:username`

Runs the Apify actor `apify/instagram-profile-scraper` for one username (no `@` prefix required). Returns `{ profile, source, actorId }` with normalized fields (`followersCount`, `profilePicUrl`, `biography`, etc.). Responds **503** with `APIFY_NOT_CONFIGURED` if `APIFY_API_TOKEN` is missing. When `ENRICHMENT_API_KEY` is set, requests without a valid key receive **401**. Per-IP rate limits and an in-memory username cache (see env vars) reduce abuse and duplicate Apify spend.

### `POST /api/v1/discovery/instagram`

Request body:

```json
{
  "niche": "Fitness",
  "location": "Bangalore",
  "audienceType": "Gen Z snack brand",
  "limit": 10
}
```

- `niche` is required; `location`, `audienceType`, and `limit` (1–25, default 10) are optional.
- `platform` is accepted only as `"instagram"` or empty in this version.

Response:

```json
{
  "query": { "niche": "Fitness", "location": "Bangalore", "audienceType": "Gen Z snack brand", "limit": 10, "platform": "instagram" },
  "requestId": "anakin-request-id",
  "stages": {
    "searchMode": "auto",
    "searchProvider": "anakin-search",
    "search": 5,
    "scrapedArticles": 3,
    "anakinGenerateJson": true,
    "groqCreators": 2,
    "usedFallback": false,
    "llmProvider": "groq",
    "llmModel": "llama-3.1-8b-instant",
    "llmStatus": "ok"
  },
  "count": 2,
  "influencers": [
    {
      "id": "abc123",
      "name": "Display name",
      "handle": "creator_handle",
      "profileUrl": "https://instagram.com/creator_handle",
      "platform": "instagram",
      "snippet": "Short text from the source page",
      "sourceUrl": "https://example.com/article",
      "followerCount": 250000,
      "publishedAt": null
    }
  ]
}
```

`followerCount` is best-effort: when Groq extraction succeeds it comes from the `followerText` the model lifted out of the article; otherwise the legacy regex parses the search snippet/title (e.g. `250k followers`, `1.2M followers`). Rows with no parsed count are sorted last. Reliable per-profile metrics arrive only when `DISCOVERY_PROFILE_SCRAPE_MAX > 0` and Anakin URL Scraper successfully reads the live profile.

## Discovery pipeline

The endpoint runs three stages internally:

1. **Search** — finds article URLs about creators in the niche. Two backends, both Anakin:
   - **Primary:** Anakin Search ([`services/anakinSearch.js`](services/anakinSearch.js)) — `POST /v1/search`.
   - **Fallback:** Anakin URL Scraper used as a SERP scraper ([`services/anakinSerpSearch.js`](services/anakinSerpSearch.js)) — submits a DuckDuckGo HTML SERP URL to `POST /v1/url-scraper`, then parses the returned markdown into `{title, url, snippet}` rows. Triggered automatically when `/v1/search` errors or returns 0 results (or always, when `DISCOVERY_SEARCH_MODE=serp`).
2. **Anakin URL Scraper** ([`services/anakinUrlScraper.js`](services/anakinUrlScraper.js)) — optional. Fetches markdown for the top `DISCOVERY_ARTICLE_SCRAPE_MAX` non-Instagram URLs. When **`DISCOVERY_ANAKIN_GENERATE_JSON=true`** (default), scrapes also request **`generateJson`** so Anakin returns **`generatedJson`** (hosted structured extraction). [`groqExtractCreators.js`](services/groqExtractCreators.js) then prefers **`JSON.stringify(generatedJson.data)`** under `STRUCTURED_JSON` in the Groq prompt instead of dumping full markdown — fewer input tokens and fewer Groq TPM spikes. If JSON is missing or failed, content falls back to truncated markdown as before.
3. **Groq JSON extraction** ([`services/groqExtractCreators.js`](services/groqExtractCreators.js)) — bundles snippets + per-source content into one prompt and asks Groq (default **`llama-3.1-8b-instant`**) for a strict JSON list of creators (`handle`, `displayName`, `followerText`, `evidenceSnippet`, `sourceUrl`).

The response includes a `stages` object (see **Observability** below). If Groq fails or is disabled, the pipeline falls back to the legacy snippet-only mapper so the dashboard never shows zero rows when search returned data. See [`docs/anakin-api-overview.md`](docs/anakin-api-overview.md) for the full Anakin product comparison.

## Observability

Discovery runs emit structured server logs via [`services/discoveryLog.js`](services/discoveryLog.js): each line is `console.log('[discovery]', <event>, JSON.stringify(fields))`. Human-readable step lines use `logPipelineStep` (grep for `STEP 1/4` in the server console). Events include `search_complete`, `scrape_complete`, `wire_job_complete`, `llm_*`, and `pipeline_complete`. Never log API keys or full prompts.

The JSON response **`stages`** field is additive:

| Field | Meaning |
|--------|---------|
| `searchMode` | Env `DISCOVERY_SEARCH_MODE`: `auto`, `api`, `serp`, or `wire`. |
| `searchProvider` | Actual path used: `anakin-wire`, `anakin-search`, `serp`, or `serp-fallback`. |
| `traceId` | Short id correlating all log lines for one request. |
| `apisUsed` | Anakin/Groq endpoints touched, e.g. `POST /v1/holocron/task#yt_search`, `POST /v1/url-scraper#youtube_subscribers`. |
| `platform` | `instagram` or `youtube` (forced by route path). |
| `metricLabel` | `Followers` or `Subscribers` for UI. |
| `llmProvider` | `groq` when Groq was invoked (rows returned, empty JSON, or HTTP error); `none` when Groq was not called (e.g. no SOURCES built). |
| `llmModel` | Resolved Groq model id when the LLM path applies; otherwise `null`. |
| `llmStatus` | `ok`, `skipped`, or `error` (Groq attempted and failed). |
| `usedFallback` | `true` when the snippet-only mapper was used for the returned list. |

**YouTube subscribers:** after `yt_channel`, the pipeline optionally scrapes the channel URL (`DISCOVERY_YOUTUBE_SUBSCRIBER_SCRAPE=true`) and parses subscriber text from markdown — Groq/snippet guesses are not used for YouTube counts.

**Platform isolation:** [`services/platformConfig.js`](services/platformConfig.js) enforces allowed profile hosts per platform. `/api/v1/discovery/youtube` always sets `platform: youtube`; Instagram Apify enrichment on the detail page runs only for Instagram rows.

### Manual smoke test

With both keys set in `.env`:

```bash
npm run dev
# in another terminal
curl -X POST http://localhost:3000/api/v1/discovery/instagram \
  -H "Content-Type: application/json" \
  -d "{\"niche\":\"Fitness\",\"location\":\"Bangalore\",\"audienceType\":\"Gen Z snack brand\"}"
```

Expect a `200` with an `influencers[]` array. Pure helpers (`parseFollowerCount`, Groq response parsing) are covered by `npm test`.
