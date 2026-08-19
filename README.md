# bookmark-sync-engine

A personal, cross-browser bookmark sync engine. A lightweight MV3 browser extension forwards every new bookmark to a Cloudflare Worker, which scrapes the page, generates tags with Workers AI, and indexes everything for full-text search — all asynchronously, so the browser never waits on it.

## Architecture

The Worker is layered so each concern is isolated behind an interface, wired together in one composition root (`src/container.ts`):

- **`src/index.ts`** — [Hono](https://hono.dev) app: CORS, the `deps` middleware (builds per-request dependencies via `buildDependencies()` and stashes them on context), and mounts the versioned API at `/api/v1`.
- **`src/routes/v1/`** — HTTP layer only. Each handler reads `c.get('deps')` and calls into the repository/pipeline abstractions — no direct D1/AI/Browser access.
- **`src/repositories/bookmark-repository.ts`** — `BookmarkRepository` interface + `D1BookmarkRepository` implementation. All SQL lives here.
- **`src/services/page-scraper.ts`** — `PageScraper` interface + `BrowserRenderingScraper` implementation (Puppeteer over the `BROWSER` binding).
- **`src/services/tag-generator.ts`** — `TagGenerator` interface + `WorkersAiTagGenerator` implementation (`@cf/meta/llama-3.1-8b-instruct-fp8`), producing freeform AI tags (many per bookmark).
- **`src/services/category-classifier.ts`** — `CategoryClassifier` interface + `WorkersAiCategoryClassifier` implementation. Suggests a *single* category for a bookmark with no real folder, constrained to categories already in use (see [Categorization](#categorization-folders-tags--ai-suggestions) below).
- **`src/services/category-reorganizer.ts`** — `CategoryReorganizer` interface + `WorkersAiCategoryReorganizer` implementation (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Analyzes the whole category list at once and proposes renames/merges for poorly-organized ones — a one-shot, user-triggered analysis, not part of the per-bookmark pipeline.
- **`src/services/bookmark-ingestion-pipeline.ts`** — orchestrates scrape → tag → (optionally) categorize → persist for one bookmark; depends only on the interfaces above via constructor injection.
- **`src/container.ts`** — the only file that instantiates concrete classes from `Env`; everything else depends on interfaces.
- **`src/lib/validation.ts`** — pure helpers (URL validation, FTS query escaping, tag/category length bounds).
- **`schema.sql`** — D1 (SQLite) schema: a `bookmarks` table (with `tags` and `category` columns — see [Categorization](#categorization-folders-tags--ai-suggestions)) plus an FTS5 external-content index (`bookmarks_fts`) kept in sync via triggers.
- **`extension/`** — MV3 browser extension (Chrome/Edge/Firefox).
  - `background.js` — listens for `browser.bookmarks.onCreated`, derives each bookmark's category from its real folder path (`resolveCategoryPath`), POSTs new bookmarks to the Worker, and runs the bulk-import loop (`importAllBookmarks`, triggered by a message from the popup). Writes every sync attempt to `browser.storage.local` (`syncState`, `recentActivity`, `settings`).
  - `popup.html` / `popup.js` / `popup.css` — the toolbar popup: import button, live recent-activity list (driven by `browser.storage.onChanged`), a link to the Library page, and the "suggest categories for unfiled bookmarks" toggle.
  - `library.html` / `library.js` / `library.css` — a full-tab page for browsing your synced bookmarks: search, and sidebars for filtering by category or tag.
  - Uses Mozilla's [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill) (vendored at `extension/browser-polyfill.js`) so the same code runs against Chrome's callback-based `chrome.*` APIs and Firefox's native promise-based `browser.*` APIs. `manifest.json` declares both `background.service_worker` (Chrome/Edge) and `background.scripts` (Firefox); Chrome loads the polyfill via `importScripts` internally, Firefox loads it as a normal background script first.

Bindings used by the Worker (declared in `wrangler.toml`):
- `DB` — D1 database (`bookmarks-db`)
- `AI` — Workers AI, used to auto-tag/categorize each bookmark (`@cf/meta/llama-3.1-8b-instruct-fp8`) and, on demand, to suggest a category reorganization (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
- `BROWSER` — Browser Rendering, used to scrape page title/body text

## API reference

All routes are versioned under `/api/v1`.

### `GET /api/v1/health`
Liveness check: `{ "ok": true, "service": "bookmark-sync-engine" }`.

### `POST /api/v1/bookmarks`
Body: `{ "url": string, "title"?: string, "category"?: string, "suggestCategory"?: boolean }`

Saves the bookmark as `pending` and returns immediately (`202`). Scraping and tagging happen in the background; scraped body text also feeds the optional AI category step. Returns `200` with the existing record if the URL was already saved.

- `category`, when present, is the extension's real browser folder path — it's never an AI guess, so it's always trusted over whatever was stored before, including on a dedupe hit against an existing bookmark that already had a (different) category. This is what lets a re-import follow you moving a bookmark to a different real folder.
- `suggestCategory` only takes effect when `category` is absent (a real folder always wins). When true, the background pipeline asks Workers AI to pick a best-fit category from ones already in use.
- If neither is given, the bookmark stays uncategorized.

### `GET /api/v1/bookmarks?tag=...&category=...&limit=...&offset=...`
Lists bookmarks, most recent first, optionally filtered to one tag or one category (tag wins if both are given). Powers the extension's Library page. `limit` defaults to 50, capped at 200.

### `GET /api/v1/search?q=...`
Full-text search over title, scraped body text, tags, and category. Returns matches ranked by BM25 with a highlighted snippet.

### `GET /api/v1/bookmarks/url-categories`
Returns `{ categories: { [url]: category | null } }` for every stored bookmark — no title/body/tags, just enough to check "would this URL's category change?". The extension fetches this once before a re-import so it can skip re-POSTing any bookmark whose folder-derived category hasn't changed since last time, instead of hitting the network for every single bookmark on every import.

### `GET /api/v1/bookmarks/:id`
Fetch a single bookmark by id — useful for polling processing status (`pending` → `processed` / `failed`).

### `GET /api/v1/tags`
Distinct AI-generated tags with counts, most-used first.

### `GET /api/v1/categories`
Distinct categories with counts, most-used first. This is also the exact list `WorkersAiCategoryClassifier` is constrained to pick from — see [Categorization](#categorization-folders-tags--ai-suggestions).

### `POST /api/v1/categories/suggest-reorganization`
Read-only. Analyzes the *entire* current category list at once (not per-bookmark) and proposes renames/merges for poorly-organized ones — duplicate concepts, folders nested many levels deep for 1-2 bookmarks, misplaced categories. Returns `{ suggestions: [{ from, to, reason }, ...] }`. Most categories should have nothing suggested — see [Categorization](#categorization-folders-tags--ai-suggestions).

### `POST /api/v1/categories/reorganize`
Body: `{ "mapping": [{ "from": string, "to": string }, ...] }`

Applies a reorganization mapping (normally a user-reviewed subset of what `/suggest-reorganization` returned) — one `UPDATE bookmarks SET category = to WHERE category = from` per entry, run as a single D1 batch. Every `from` is re-validated against the *current* category list before applying (not trusted from the request body), since categories can change between generating a suggestion and applying it; stale entries are silently dropped rather than erroring the whole request. Returns `{ applied: <count> }`.

Every route except `/api/v1/health` requires `Authorization: Bearer <API_TOKEN>` — see [Security](#security).

## Local development

```sh
npm install
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm run db:init      # apply schema.sql to the local D1 database
```

## Deploying

The Worker is deployed at `bookmarks.njmtech.co.za` via the `routes` entry in `wrangler.toml` (a Cloudflare custom domain — requires `njmtech.co.za` to be an active zone on the same Cloudflare account).

**Automatic (recommended):** pushing to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which typechecks and then runs `wrangler deploy`. This requires two repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

**Manual:**

`wrangler` needs to be authenticated. An interactive `wrangler login` session works but can expire; a `.env` with an API token (same mechanism as CI, above) doesn't:

```sh
cp .env.example .env   # then fill in CLOUDFLARE_API_TOKEN (create one at
                        # Cloudflare dashboard → My Profile → API Tokens →
                        # "Edit Cloudflare Workers" template)
set -a; source .env; set +a   # env vars don't persist across shells/commands
                                # on their own — source this before each
                                # wrangler command that needs auth
npm run deploy
```

If a deploy reports `Authentication error [code: 10000]` specifically on a `/zones/.../workers/routes` request, the Worker script itself still uploaded fine (that error is scoped to re-asserting the custom domain route) — the token just also needs zone-level **Workers Routes: Edit** permission for `njmtech.co.za` to clear that specific warning.

**D1 schema changes are never applied automatically.** `schema.sql` starts with `DROP TABLE IF EXISTS`, so running it against the remote database is destructive and must always be a deliberate, manual step:

```sh
npm run db:init:remote
```

## Security

- **Authentication**: every route except `/api/v1/health` requires `Authorization: Bearer <API_TOKEN>` (`hono/bearer-auth`, constant-time comparison). The token lives only in the Cloudflare secret store — never in `wrangler.toml` or source:
  ```sh
  wrangler secret put API_TOKEN   # prompts for the value; generate one with:
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```
  The extension needs the same value in `extension/config.js` (gitignored — copy `extension/config.example.js` and fill it in). If the secret is ever rotated, update both places.
- Response security headers (`hono/secure-headers`) and a generic, non-leaking `onError` handler (errors are logged server-side, never returned to the client).
- Request body size capped at 8KB on `POST /api/v1/bookmarks` (`hono/body-limit`).
- `url`/`title` fields are length-bounded (2048 / 500 chars) before being stored or sent to the tagging model.
- Before scraping, a bookmarked URL's hostname is checked against loopback/private/link-local ranges (including `169.254.169.254`, the common cloud-metadata SSRF target) and rejected if it matches — see `isPubliclyRoutableUrl` in `src/lib/validation.ts`. This is a literal hostname check, not DNS-based, so it doesn't defend against DNS rebinding; Workers has no raw DNS API to do better.
- FTS5 search input is quoted per-token before being used in a `MATCH` query, so raw FTS operators (`-`, `"`, `:`) in user search input can't break out of the query — see `buildFtsMatchQuery`.
- `WorkersAiCategoryClassifier`'s output is validated against the real category list in code, not trusted as-is — an LLM ignoring its system prompt can't smuggle an arbitrary string into the `category` column this way.

**Known gap:** no rate limiting. The bearer token stops drive-by public abuse (the main realistic threat for a personal tool), but there's no protection against a leaked token or a runaway extension bug hammering the endpoint. Deliberately deferred.

## Loading the browser extension

The extension already points at `https://bookmarks.njmtech.co.za` (`extension/manifest.json` and `extension/background.js`), which is deployed as a Cloudflare custom domain — see below.

1. Copy `extension/config.example.js` to `extension/config.js` and set `API_TOKEN` to the same value you set with `wrangler secret put API_TOKEN` (see [Security](#security)). `config.js` is gitignored — it holds a real secret.
2. In Chrome/Edge, go to `chrome://extensions`, enable **Developer mode**, and click **Load unpacked** → select the `extension/` folder. (Firefox: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `extension/manifest.json`. Firefox drops temporary add-ons on restart, so you'll need to reload it each session.)
3. New bookmarks you create will now sync automatically.

### Popup: importing existing bookmarks & sync activity

Click the extension's toolbar icon to open a popup (`extension/popup.html`) showing:
- An **Import all bookmarks** button — walks the full existing bookmark tree and POSTs each one to `/api/v1/bookmarks`, with a short delay between requests (no server-side rate limiting exists yet, and Browser Rendering/Workers AI both have concurrency limits — importing hundreds at once would fire that many scrape+tag pipelines simultaneously). Before the loop starts, it fetches `GET /api/v1/bookmarks/url-categories` once and skips (no POST, no delay) any bookmark whose folder-derived category already matches what's stored — so re-running Import after the first full import is fast, touching only bookmarks that are new or that moved to a different real folder. A live `Importing N / total…` progress line updates as it goes (skipped bookmarks still count toward progress, just without a network round trip). Safe to click more than once or mid-import — the Worker also dedupes by URL server-side, so even an unskipped already-synced bookmark just gets a cheap `200` instead of being reprocessed. Each POST has a 20s timeout (`AbortController` in `syncBookmark`) — the import loop is fully sequential (one `await` at a time), so without a bound, a single hung request would stall every bookmark after it indefinitely instead of just counting as one failure and moving on.
- A **Suggest categories for unfiled bookmarks (AI)** toggle — see [Categorization](#categorization-folders-tags--ai-suggestions).
- A **View library** button — opens `library.html` in a new tab.
- A **Recent activity** list showing the last 20 sync attempts (new bookmarks and imported ones alike) with a ✓/✗ status. This reflects whether the Worker *accepted* the POST, not whether its background scrape/tag pipeline has finished — checking that requires polling `GET /api/v1/bookmarks/:id` separately.

Background script and popup share state through `browser.storage.local` (`syncState`, `recentActivity`, `settings`), so the popup shows the correct state whether it's open during an import or opened afterward.

**The Library page also watches `syncState`** (`browser.storage.onChanged`) and shows an import-progress banner, since it otherwise only fetches categories/tags/bookmarks once on load — without this, a Library tab left open during a long import would keep showing a stale, partial snapshot (e.g. a folder that hasn't shown its subfolders yet simply because those bookmarks haven't synced yet). It refreshes at most every ~4s while an import is running (not on every single tick — that would be chatty and could reset your scroll position or an in-progress interaction), plus once immediately when the import finishes. Expanded tree state (`expandedCategoryPaths`) survives these refreshes since it's tracked independently of the fetched data.

### Library page: browsing & searching your bookmarks

Click **View library** in the popup to open `extension/library.html` in a full tab. It has a search box (hits `/api/v1/search`) and two sidebars — **Categories** and **Tags** — each pulled from `/api/v1/categories` and `/api/v1/tags`. Clicking a category or tag filters the list (`/api/v1/bookmarks?category=...` / `?tag=...`); clicking a bookmark's category label or tag pill filters by that same value (and expands that sidebar section if it was collapsed). Category and tag filters are mutually exclusive, and search takes priority over both.

Each sidebar section (Categories, Tags) is collapsible — click the heading to toggle. Tags starts collapsed by default since that list is usually much longer than Categories; both scroll within a bounded height (rather than pushing the page down) once expanded.

**Categories render as a real folder tree**, built client-side from the flat slash-joined category paths `/api/v1/categories` returns (no backend change — the API still just returns a flat list; `buildCategoryTree`/`renderTreeNode` in `library.js` parse it into a nested structure). Each folder node has its own independent expand/collapse chevron, collapsed by default; clicking a node's name filters to bookmarks with *exactly* that category (matching the existing `GET /api/v1/bookmarks?category=` exact-match behavior — clicking "Dev Tools" shows only bookmarks filed directly there, not ones in its "Tools"/"AI Interfaces" subfolders too, same as a normal file-explorer). A node can be both a real, clickable category (some bookmark's category is literally `"Dev Tools"`) *and* have children (deeper categories like `"Dev Tools/Tools"`) at the same time — those are tracked independently. A node with children but no bookmarks of its own (e.g. `"Learning"` when nothing is filed there directly, only in `"Learning/Courses"`) renders as a plain, non-clickable label — it's just organizational. Selecting a deeply-nested category (via search result, a card's category label, etc.) auto-expands every ancestor folder so the active node is actually visible rather than hidden inside a collapsed parent.

Search result snippets highlight matches using `U+0001`/`U+0002` markers from D1's `snippet()` (not literal HTML — the underlying text is a scraped page's own content, which is untrusted), split and rendered as `<mark>` elements via `textContent`, never `innerHTML`.

### Categorization: folders, tags & AI suggestions

Two independent classification schemes:
- **Category** — a single hierarchical path (e.g. `Dev Tools/AI APIs & Integrations`), mirroring the bookmark's real place in your browser's folder structure. `background.js` derives this by walking up from the bookmark's parent folder (live creates) or from the full tree during import (`resolveCategoryPath` / `collectSyncableBookmarks`), stopping before the browser's own built-in containers ("Bookmarks bar", "Other bookmarks", Firefox's "menu"/"toolbar"/"unfiled", etc. — these aren't real categories). A bookmark saved directly into one of those containers, with no subfolder, has no category.
- **Tags** — freeform, multiple, AI-generated per bookmark (unchanged from before) — see `WorkersAiTagGenerator`.

**A real folder always wins.** If a bookmark lives in a folder, that path becomes its category — no AI involved. AI categorization only ever applies to bookmarks with *no* folder, and only when you've turned on **Suggest categories for unfiled bookmarks (AI)** in the popup (off by default, since it's an extra Workers AI call per unfiled bookmark). When it runs, `WorkersAiCategoryClassifier` is given the full list of categories already in use (from `GET /api/v1/categories`) and picks the single best fit — or nothing, if none fit well. It's constrained to *only* return one of those existing categories: the model's raw response is checked against the real list in code (case/whitespace-normalized exact match), not just asked nicely in the prompt, so a model that ignores instructions can't invent a new category or return garbage — worst case it just falls back to uncategorized.

**Getting notified for Ctrl+D bookmarks.** Chrome/Firefox's native "add bookmark" popup is closed UI — an extension can't inject a suggestion into it directly. Instead, when a bookmark lands unfiled (the default if you don't pick a folder in that popup) and the AI-suggest setting is on, `background.js` polls `GET /api/v1/bookmarks/:id` every ~2.5s (up to ~15s) after the sync, waiting for the background pipeline to assign a category. Once one appears, it shows a native browser notification ("Suggested category: Dev Tools/AI APIs") via the `notifications` permission; clicking it opens the Library page pre-filtered to that category (`library.html?category=...`, read by `library.js` on load). This is suggestion-only — the real bookmark's actual folder location in your browser is never changed automatically, and this never applies to bookmarks you did file into a folder yourself (a real folder always wins, per above) or during bulk import (which would otherwise spam a notification per bookmark).

**Backfilling and updating categories for already-synced bookmarks:** `POST /api/v1/bookmarks` dedupes by URL. On a dedupe hit, if a `category` was supplied and it differs from what's currently stored (including "was nothing, now has one"), the row is updated to match — a real folder always wins over whatever was stored before. If no `category` was supplied and the row still has none, `suggestCategory` kicks off `BookmarkIngestionPipeline.categorizeExisting` instead (reusing the already-scraped title/body_text — no re-scrape). This means **clicking Import again** both categorizes bookmarks that were synced before this feature existed (or before you turned the AI toggle on), and follows you moving a bookmark to a different real folder since the last import.

**Skipping unchanged bookmarks on re-import:** re-processing every bookmark on every Import click would mean a full POST round trip (plus the inter-request delay) for hundreds of bookmarks that haven't moved since last time. Before the import loop starts, `background.js` fetches `GET /api/v1/bookmarks/url-categories` once and compares each bookmark's current folder-derived category against what's already stored for that URL — an exact match is skipped with no network call at all; anything new or changed still gets POSTed as usual. A failed fetch (e.g. offline) just falls back to importing everything, same as before this optimization existed.

**AI-suggested reorganization** (a third, separate AI feature from the two above): click **Suggest reorganization** below the Categories tree in the Library page to analyze your *entire* current category structure at once and propose cleanups — merges, renames, de-nesting overly-deep single-item folders. This is a one-shot, user-triggered analysis (not a per-bookmark background call), so it uses a larger model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` via `WorkersAiCategoryReorganizer`) than the per-bookmark tagging/categorizing calls — the extra latency is fine for something you trigger occasionally, and the task (reasoning holistically across dozens of categories) benefits from more capability than the small/fast model used elsewhere. Suggestions replace the bookmark list with a review panel (nothing has changed yet): each shows the old path struck through, the proposed new path, and a short reason, with a checkbox to include/exclude it. Only checked entries get sent to `POST /api/v1/categories/reorganize` when you click **Apply selected** — same "never trust the model's raw output" posture as the classifier: `from` is validated against your real category list in code both when generating suggestions and again when applying them (categories can legitimately change in between), not just requested nicely in the prompt.
