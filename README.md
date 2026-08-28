<p align="center">
  <img src="extension/icons/icon128.png" alt="Azi logo" width="112" />
</p>

# [Azi](https://bookmark.njmtech.co.za)

[![Deploy](https://github.com/omoinjm/njmtech-cross-browser-bookmark/actions/workflows/deploy.yml/badge.svg)](https://github.com/omoinjm/njmtech-cross-browser-bookmark/actions/workflows/deploy.yml)
[![Release extension](https://github.com/omoinjm/njmtech-cross-browser-bookmark/actions/workflows/release-extension.yml/badge.svg)](https://github.com/omoinjm/njmtech-cross-browser-bookmark/actions/workflows/release-extension.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Extension](https://img.shields.io/badge/extension-MV3-blue.svg)](extension/manifest.json)
[![Firefox Add-on](https://img.shields.io/badge/Firefox-Get%20the%20add--on-orange.svg)](https://addons.mozilla.org/addon/azi/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**The browser extension that remembers so you don't have to.**

A personal, cross-browser bookmark library — a lightweight MV3 browser extension forwards every new bookmark to a Cloudflare Worker, which scrapes the page, generates tags with Workers AI, and indexes everything for full-text and semantic search — all asynchronously, so the browser never waits on it.

> Repo/package name: `bookmark-sync-engine`. For architecture diagrams, the API reference, and deployment/CI internals, see [`docs/README.md`](docs/README.md).

## Usage

1. Install the extension — **[get it on Firefox](https://addons.mozilla.org/addon/azi/)**, or [load it from source](#loading-the-browser-extension) for Chrome/Edge.
2. Open the toolbar popup and get access from the **Account** tab (no sign-up form — just an email, and a password gets emailed to you).
3. Click **Import all bookmarks** once to sync your existing bookmarks, then keep bookmarking normally — new ones sync automatically.
4. Search and browse everything from the popup's **Search** tab or the full **Library** page.

See [How to use it](#how-to-use-it) for the full walkthrough.

## Stack

- **Extension** — Manifest V3 WebExtension (Chrome, Edge, Firefox), using Mozilla's [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill) for one codebase across both.
- **Backend** — [Hono](https://hono.dev) running on Cloudflare Workers, written in TypeScript.
- **Database** — Cloudflare D1 (SQLite), with an FTS5 index for full-text search.
- **AI** — Cloudflare Workers AI: Llama 3.1/3.3 for tagging, categorization, and category reorganization; `bge-base-en-v1.5` for embeddings.
- **Semantic search** — Cloudflare Vectorize.
- **Page scraping** — Cloudflare Browser Rendering (headless Chromium via `@cloudflare/puppeteer`).
- **Scheduling** — Cloudflare Cron Triggers, for the embedding backfill.
- **Testing** — Playwright (extension smoke tests), `web-ext lint` (Firefox WebExtension compatibility).
- **Tooling** — Wrangler (Worker deploys), `web-ext` (Firefox packaging/signing), GitHub Actions (CI/CD).

## How to use it

**Get access.** Open the toolbar popup → **Account** tab. There's no separate sign-up: enter your email under **Send me a password** and you'll get one by email, whether you're new or resetting access. Log in with that email/password — the session is remembered until you log out.

**Import your bookmarks.** Once logged in, the **Import** tab appears. Click **Import all bookmarks** to walk your existing bookmark tree and sync everything, with a live `Importing N / total…` progress line. Re-running Import later is fast — only new or moved bookmarks get re-synced. Any bookmark you create afterward syncs automatically in the background.

**Suggest categories.** Turn on **Suggest categories for unfiled bookmarks (AI)** (Import tab) to have AI assign a category to bookmarks you save without picking a folder. You'll get a browser notification once a suggestion is ready. A bookmark you *did* file into a folder always keeps that real folder as its category — AI never overrides it.

**Search.** Use the popup's **Search** tab for a quick lookup, or click **View library** for the full Library page — search plus sidebars for browsing by category (rendered as your real folder tree) or tag. An exact search that finds nothing automatically retries with AI-suggested related terms (e.g. `k8s` → `kubernetes, docker, devops`) and tells you what it added.

**Reorganize categories.** The popup's **Suggest** tab can analyze your entire category structure at once and propose merges, renames, or de-nesting for messy categories. Nothing changes until you review the suggestions and apply the ones you check.

## Local development

```sh
npm install
npm run dev       # wrangler dev — local Worker
npm run build     # wrangler deploy --dry-run — verifies the bundle builds, doesn't publish
npm run typecheck # tsc --noEmit
npm run db:init   # apply schema.sql to the local D1 database
```

CI (`.github/workflows/deploy.yml`) runs `build`, `typecheck`, and the [browser tests](#browser-tests) as independent parallel jobs on every push to `main`; the Worker only deploys once all three pass.

## Loading the browser extension

**Firefox:** install straight from AMO — **[addons.mozilla.org/addon/azi](https://addons.mozilla.org/addon/azi/)**. No setup needed.

**From source** (for development, or Chrome/Edge — not on a store yet):

1. `cp extension/config.example.js extension/config.js` — it already points at the production Worker; edit `WORKER_API_URL` inside only if you're running the Worker locally instead.
2. **Chrome/Edge:** go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked** → select the `extension/` folder. **Firefox:** `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `extension/manifest.json` (Firefox drops temporary add-ons on restart, so reload it each session).
3. Open the popup and get access from the **Account** tab — see [How to use it](#how-to-use-it).

## Browser tests

Two checks cover Chrome/Edge and Firefox, both run in CI on every push and runnable locally:

- **`npm run test:extension`** (`tests/extension.spec.js`, Playwright) drives the *real* unpacked extension loaded into a persistent Chromium context. Checks: the popup loads with no console/page errors and all tabs switch correctly, the Library page loads cleanly, and the manifest still declares both the Chromium (`background.service_worker`) and Firefox (`background.scripts` + `browser_specific_settings.gecko`) background entry points. The Worker API is mocked (`page.route`), so this never hits a real backend. Edge isn't driven separately — it shares Chromium's engine, so a passing Chromium run stands in for it too.
- **`npm run lint:firefox`** (`web-ext lint`) runs Mozilla's own linter against `manifest.json` and the extension's code for real Firefox/WebExtension incompatibilities — used instead of live Firefox browser automation, which has no simple unpacked-extension-loading equivalent to Chromium's `--load-extension` flag.

Neither script touches your real `extension/config.js` (gitignored, may not even exist on a fresh checkout): `web-ext lint` only reads `manifest.json`/code, and `tests/fixtures.js` copies `extension/` into a throwaway temp directory with a stub `config.js` before loading it.

## Contributing

Issues and PRs are welcome.

1. Fork the repo and branch off `main`.
2. `npm install`
3. Before opening a PR, run the same checks CI runs:
   ```sh
   npm run typecheck
   npm run build
   npm run test:extension
   npm run lint:firefox
   ```
4. For extension changes, [load the unpacked build](#loading-the-browser-extension) and click through the affected flow — the automated checks catch regressions, not new-feature correctness.
5. Open a PR describing what changed and why.

## License

[MIT](LICENSE)
