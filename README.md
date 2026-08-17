# bookmark-sync-engine

A personal, cross-browser bookmark sync engine. A lightweight MV3 browser extension forwards every new bookmark to a Cloudflare Worker, which scrapes the page, generates tags with Workers AI, and indexes everything for full-text search — all asynchronously, so the browser never waits on it.

## Architecture

- **`src/index.ts`** — [Hono](https://hono.dev) API running on Cloudflare Workers. Accepts new bookmarks, kicks off a background scrape + tagging pipeline via `waitUntil()`, and serves full-text search over the results.
- **`schema.sql`** — D1 (SQLite) schema: a `bookmarks` table plus an FTS5 external-content index (`bookmarks_fts`) kept in sync via triggers.
- **`extension/`** — MV3 browser extension (Chrome/Edge/Firefox). Listens for `chrome.bookmarks.onCreated` and POSTs the URL/title to the Worker.

Bindings used by the Worker (declared in `wrangler.toml`):
- `DB` — D1 database (`bookmarks-db`)
- `AI` — Workers AI, used to auto-tag each bookmark (`@cf/meta/llama-3.1-8b-instruct`)
- `BROWSER` — Browser Rendering, used to scrape page title/body text

## API reference

### `POST /bookmarks`
Body: `{ "url": string, "title"?: string }`

Saves the bookmark as `pending` and returns immediately (`202`). Scraping and tagging happen in the background. Returns `200` with the existing record if the URL was already saved.

### `GET /search?q=...`
Full-text search over title, scraped body text, and tags. Returns matches ranked by BM25 with a highlighted snippet.

### `GET /bookmarks/:id`
Fetch a single bookmark by id — useful for polling processing status (`pending` → `processed` / `failed`).

## Local development

```sh
npm install
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm run db:init      # apply schema.sql to the local D1 database
```

## Deploying

**Automatic (recommended):** pushing to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which typechecks and then runs `wrangler deploy`. This requires two repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

**Manual:**

```sh
npm run deploy
```

**D1 schema changes are never applied automatically.** `schema.sql` starts with `DROP TABLE IF EXISTS`, so running it against the remote database is destructive and must always be a deliberate, manual step:

```sh
npm run db:init:remote
```

## Loading the browser extension

1. In Chrome/Edge, go to `chrome://extensions`, enable **Developer mode**, and click **Load unpacked** → select the `extension/` folder. (Firefox: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `extension/manifest.json`.)
2. After your first deploy, update the placeholder Worker URL (`YOUR_WORKER_SUBDOMAIN.workers.dev`) in both:
   - `extension/manifest.json` (`host_permissions`)
   - `extension/background.js` (`WORKER_API_URL`)
3. Reload the extension. New bookmarks you create will now sync automatically.
