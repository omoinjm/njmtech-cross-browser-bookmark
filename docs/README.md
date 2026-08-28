# Azi — project setup

This document describes how **Azi** (`bookmark-sync-engine`) is put together: the browser extension, Cloudflare Worker backend, supporting services, and how changes reach production.

## System overview

```mermaid
flowchart TB
  subgraph browsers [Browser clients]
    extPopup["Extension popup\npopup.html"]
    extLibrary["Azi Library\nlibrary.html"]
    extBg["Background script\nbackground.js"]
    nativeBm["Native bookmarks\nChrome / Edge / Firefox"]
  end

  subgraph hosting [Hosted services]
    api["Cloudflare Worker\napi.bookmark.njmtech.co.za"]
    site["GitHub Pages\nbookmark.njmtech.co.za"]
    emailApi["Email template API\napi.template.njmtech.co.za"]
  end

  subgraph cloudflare [Cloudflare bindings]
    d1[("D1 SQLite\nbookmarks-db")]
    ai["Workers AI\nLlama models"]
    browser["Browser Rendering\nheadless Chromium"]
    vec["Vectorize\nbookmarks-embeddings"]
  end

  nativeBm -->|"onCreated / import"| extBg
  extPopup --> extBg
  extLibrary --> extBg
  extBg -->|"HTTPS + session token\n/api/v1/*"| api
  api --> d1
  api --> ai
  api --> browser
  api --> vec
  api -->|"account credentials email"| emailApi
  site -.->|"marketing / login link"| extPopup
```

| Component | Location | Role |
|---|---|---|
| **Extension** | `apps/extension/extension/` | MV3 add-on for Chrome, Edge, and Firefox. Syncs bookmarks, provides popup, Library UI, and omnibox search. |
| **Worker API** | `apps/worker/src/` → `wrangler deploy` | Hono app at `/api/v1`. Auth, bookmark CRUD, search, AI tagging/categorization. |
| **Marketing site** | `apps/website/` | Static landing page on GitHub Pages. |
| **Config** | `apps/extension/extension/config.js` (gitignored) | Points extension at `WORKER_API_URL`. Session token stored in `browser.storage.local` after login. |

## Bookmark ingestion flow

When a bookmark is created or imported, the extension POSTs immediately and the Worker finishes processing in the background.

```mermaid
sequenceDiagram
  participant User
  participant Ext as Extension background.js
  participant API as Worker /api/v1
  participant Pipe as Ingestion pipeline
  participant Scraper as Browser Rendering
  participant TagAI as Workers AI
  participant DB as D1 + FTS5 + Vectorize

  User->>Ext: Save bookmark / Import all
  Ext->>API: POST /bookmarks {url, title, category}
  API->>DB: Insert row status=pending
  API-->>Ext: 202 Accepted

  Note over API,Pipe: ctx.waitUntil — async, non-blocking

  API->>Pipe: run ingestion
  Pipe->>Scraper: fetch page title + body
  Scraper-->>Pipe: scraped text
  Pipe->>TagAI: generate tags
  TagAI-->>Pipe: tags
  opt suggestCategory and no folder
    Pipe->>TagAI: pick category from existing list
    TagAI-->>Pipe: category suggestion
  end
  Pipe->>DB: UPDATE processed + FTS sync + embedding
```

## Worker internals

The Worker is layered behind interfaces; `apps/worker/src/container.ts` wires concrete Cloudflare bindings to route handlers.

```mermaid
flowchart LR
  subgraph http [HTTP layer]
    index["apps/worker/src/index.ts\nHono + CORS + deps middleware"]
    routes["apps/worker/src/routes/v1/\nbookmarks, search, auth, tags, categories"]
  end

  subgraph services [Services]
    pipeline["bookmark-ingestion-pipeline"]
    scraper["page-scraper"]
    tagger["tag-generator"]
    classifier["category-classifier"]
    reorganizer["category-reorganizer"]
    embedder["embedding-generator"]
    semantic["semantic-index"]
  end

  subgraph data [Data layer]
    repo["bookmark-repository"]
    userRepo["user-repository"]
    sessionRepo["session-repository"]
  end

  index --> routes
  routes --> pipeline
  routes --> repo
  routes --> userRepo
  routes --> sessionRepo
  pipeline --> scraper
  pipeline --> tagger
  pipeline --> classifier
  scraper --> repo
  tagger --> repo
  classifier --> repo
  routes --> reorganizer
  routes --> semantic
  semantic --> embedder
  embedder --> repo
```

## Deployment and CI

Four GitHub Actions workflows publish different parts of the project. Extension releases are deliberately split into three independent, browser-specific workflows (rather than one combined one) — each triggers off the same tag push and attaches its own zip to the same GitHub Release, coordinated via a shared `concurrency.group` (GitHub enforces these repo-wide across different workflow files, so all three release jobs for one tag run one-at-a-time instead of racing to create the release).

```mermaid
flowchart TB
  subgraph repo [Git repository main branch]
    srcCode["apps/worker/\n(src/, wrangler.toml)"]
    extCode["apps/extension/extension/"]
    webCode["apps/website/"]
  end

  subgraph ciWorker [deploy.yml]
    build["npm run build"]
    typecheck["npm run typecheck"]
    xbrowser["Playwright + web-ext lint"]
    wranglerDeploy["wrangler deploy"]
  end

  subgraph ciFirefox [release-firefox.yml]
    ffPack["package:firefox\n(azi-version.zip)"]
    amoSubmit["publish:firefox\n(web-ext sign)"]
  end

  subgraph ciChrome [release-chrome.yml]
    chromePack["package:chrome\n(azi-version-chrome.zip)"]
  end

  subgraph ciEdge [release-edge.yml]
    edgePack["package:edge\n(azi-version-edge.zip)"]
    edgeSubmit["publish-edge.js"]
  end

  ghRelease["GitHub Release\n(one release, three zips —\nconcurrency-serialized writes)"]

  subgraph ciPages [deploy-pages.yml]
    pagesDeploy["GitHub Pages\napps/website/ artifact"]
  end

  subgraph prod [Production]
    workerProd["Worker\napi.bookmark.njmtech.co.za"]
    pagesProd["Site\nbookmark.njmtech.co.za"]
    amo["Firefox AMO\nauto-submitted for review"]
    edge["Microsoft Edge Add-ons\nauto-submitted for review\n(after first listing exists)"]
    opera["Opera Add-ons\nmanual upload — no public API"]
    chromeStore["Chrome Web Store\nnot wired up yet ($5 fee pending)"]
  end

  extCode --> ffPack --> amoSubmit --> amo
  extCode --> chromePack
  extCode --> edgePack --> edgeSubmit --> edge

  ffPack --> ghRelease
  chromePack --> ghRelease
  edgePack --> ghRelease

  chromePack -.->|"manual (also works for Opera)"| opera
  chromePack -.->|"manual, once registered"| chromeStore

  srcCode --> build
  srcCode --> typecheck
  extCode --> xbrowser
  build --> wranglerDeploy
  typecheck --> wranglerDeploy
  xbrowser --> wranglerDeploy
  wranglerDeploy --> workerProd

  webCode --> pagesDeploy
  pagesDeploy --> pagesProd
```

### Secrets and config

| Where | What |
|---|---|
| **Cloudflare** | `API_TOKEN` via `wrangler secret put`; D1, AI, Browser Rendering, Vectorize bindings in `apps/worker/wrangler.toml` |
| **GitHub Actions (Worker)** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` for Worker deploy (workflow sets `workingDirectory: apps/worker` on the wrangler-action step) |
| **GitHub Actions (Firefox)** | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` — API key/secret from [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) |
| **GitHub Actions (Edge)** | `EDGE_CLIENT_ID`, `EDGE_API_KEY` from Partner Center → Microsoft Edge → **Publish API** → Create API credentials; `EDGE_PRODUCT_ID` from the extension's page in Partner Center |
| **Extension (local / zip)** | Copy `apps/extension/extension/config.example.js` → `apps/extension/extension/config.js`; login via popup Account tab |

Any of the store secrets missing just skips that store's submission step — the GitHub Release step always runs regardless.

### Packaging: three different zips, not one

There are **three** build flavors, and they are not interchangeable between the Firefox one and the other two — Chromium's package validator (used by both Edge Add-ons and, since Opera is also Chromium-based, almost certainly Opera Add-ons and the Chrome Web Store too) rejects two things the Firefox-oriented manifest has:

- `background.scripts` present alongside `background.service_worker` under `manifest_version: 3` (Firefox needs `scripts`; Chrome/Edge only ever read `service_worker` and `background.js` picks its own bootstrap path via `typeof importScripts`, so `scripts` is dead weight there)
- a `description` over 132 characters (Firefox/AMO has no such limit)

```sh
npm run package:firefox   # apps/extension/web-ext-artifacts/azi-<version>.zip          — Firefox/AMO
npm run package:chrome    # apps/extension/web-ext-artifacts/azi-<version>-chrome.zip   — Chrome (and Opera)
npm run package:edge      # apps/extension/web-ext-artifacts/azi-<version>-edge.zip     — Microsoft Edge
```

`package:chrome` and `package:edge` are two thin wrappers around one shared prep step, `npm run package:chromium` (→ `apps/extension/scripts/build-chromium-package.js`) — there's no real difference between what Chrome and Edge need, so both are built from the exact same rewritten manifest (copies `apps/extension/extension/` into a gitignored `apps/extension/.chromium-build/`, strips `background.scripts` and `browser_specific_settings`, swaps in a ≤132-character description), just packaged under two different filenames. **Use either the `-chrome.zip` or `-edge.zip` build for Opera's manual upload too** (they're identical) — the plain Firefox zip will fail Opera's validator with the same errors Chrome/Edge give.

All three packaging scripts always overwrite `apps/extension/extension/config.js` from `apps/extension/extension/config.example.js` before building, regardless of whatever `config.js` already exists locally — a distributable package must never be able to ship a developer's local override or stale secret.

### GitHub Releases, and auto-submission to Firefox/Edge

Three independent workflows — [`release-firefox.yml`](../.github/workflows/release-firefox.yml), [`release-chrome.yml`](../.github/workflows/release-chrome.yml), [`release-edge.yml`](../.github/workflows/release-edge.yml) — each lint (Firefox only)/package/(maybe submit)/attach-to-release when you push a version tag:

```sh
# 1. Bump "version" in apps/extension/extension/manifest.json first
git tag v1.0.2
git push origin v1.0.2
```

The tag (`v1.0.2`) must match the manifest version (`1.0.2`). All three workflows fire on that same push and end up attaching their own zip to **one shared GitHub Release** for that tag — `release-firefox.yml` owns the release's title/body/generated notes (a body that lists all three zips), and the other two only supply `files:`, which `softprops/action-gh-release` treats as additive and leaves other fields untouched — so it doesn't matter which of the three actually runs first. You can also run any one of them manually from the Actions tab (**workflow_dispatch**), but that only builds/attaches *that one* browser's zip, not the other two — for a real full release, push a tag so all three fire together.

If the secrets above are configured:

- **`release-firefox.yml` submits to Firefox AMO** for signing/review via `npm run publish:firefox` (`web-ext sign --channel=listed`).
- **`release-edge.yml` submits to Microsoft Edge Add-ons** for review via `apps/extension/scripts/publish-edge.js`, calling the [Edge Add-ons Update REST API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api) directly: upload the draft package, poll until processed, publish the draft, poll until that clears too. This API can only update an **existing** Edge listing — the very first submission for a new extension still has to be done by hand in Partner Center before this takes over.

Both submission steps are `continue-on-error: true`, so a store review delay/timeout never blocks that workflow's GitHub Release step.

**Opera Add-ons** has no public submission API (confirmed against Opera's own developer docs — their "Add-ons API" is a client-side `installExtension()` call, unrelated to publishing), so every Opera release — first and subsequent — means uploading either the `-chrome.zip` or `-edge.zip` build (identical Chromium packages, not the plain Firefox one) by hand at [addons.opera.com/developer](https://addons.opera.com/developer/).

**Chrome Web Store** isn't wired up at all yet (pending the one-time $5 developer registration fee) — `release-chrome.yml` still builds and attaches `azi-<version>-chrome.zip` to every release, just with no submission step. For now, Chrome users load that zip unpacked via `chrome://extensions` → Developer mode → Load unpacked.

## Local development

```sh
npm install
npm run dev          # wrangler dev — local Worker
npm run db:init      # apply apps/worker/schema.sql to local D1
npm run typecheck
npm run test:extension
npm run lint:firefox
```

Load the extension unpacked from `apps/extension/extension/` in `chrome://extensions` or Firefox `about:debugging`.
