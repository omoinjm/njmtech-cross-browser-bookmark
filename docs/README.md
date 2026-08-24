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
| **Extension** | `extension/` | MV3 add-on for Chrome, Edge, and Firefox. Syncs bookmarks, provides popup, Library UI, and omnibox search. |
| **Worker API** | `src/` → `wrangler deploy` | Hono app at `/api/v1`. Auth, bookmark CRUD, search, AI tagging/categorization. |
| **Marketing site** | `website/` | Static landing page on GitHub Pages. |
| **Config** | `extension/config.js` (gitignored) | Points extension at `WORKER_API_URL`. Session token stored in `browser.storage.local` after login. |

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

The Worker is layered behind interfaces; `src/container.ts` wires concrete Cloudflare bindings to route handlers.

```mermaid
flowchart LR
  subgraph http [HTTP layer]
    index["src/index.ts\nHono + CORS + deps middleware"]
    routes["src/routes/v1/\nbookmarks, search, auth, tags, categories"]
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

Two GitHub Actions workflows publish different parts of the project.

```mermaid
flowchart TB
  subgraph repo [Git repository main branch]
    srcCode["src/ + wrangler.toml"]
    extCode["extension/"]
    webCode["website/"]
  end

  subgraph ciWorker [deploy.yml]
    build["npm run build"]
    typecheck["npm run typecheck"]
    xbrowser["Playwright + web-ext lint"]
    wranglerDeploy["wrangler deploy"]
  end

  subgraph ciRelease [release-extension.yml]
    extLint["web-ext lint"]
    extPack["package:firefox"]
    ghRelease["GitHub Release\nazi-version.zip"]
  end

  subgraph ciPages [deploy-pages.yml]
    pagesDeploy["GitHub Pages\nwebsite/ artifact"]
  end

  subgraph prod [Production]
    workerProd["Worker\napi.bookmark.njmtech.co.za"]
    pagesProd["Site\nbookmark.njmtech.co.za"]
    amo["Firefox AMO\nmanual upload"]
  end

  extCode --> extLint
  extLint --> extPack
  extPack --> ghRelease

  srcCode --> build
  srcCode --> typecheck
  extCode --> xbrowser
  build --> wranglerDeploy
  typecheck --> wranglerDeploy
  xbrowser --> wranglerDeploy
  wranglerDeploy --> workerProd

  webCode --> pagesDeploy
  pagesDeploy --> pagesProd

  extCode --> amo
```

### Secrets and config

| Where | What |
|---|---|
| **Cloudflare** | `API_TOKEN` via `wrangler secret put`; D1, AI, Browser Rendering, Vectorize bindings in `wrangler.toml` |
| **GitHub Actions** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` for Worker deploy |
| **Extension (local / zip)** | Copy `extension/config.example.js` → `extension/config.js`; login via popup Account tab |

### Packaging for Firefox

Build an AMO upload zip locally from the repo root:

```sh
npm run package:firefox
```

Output: `web-ext-artifacts/azi-<version>.zip` (version from `extension/manifest.json`).

### GitHub Releases

The [`release-extension.yml`](../.github/workflows/release-extension.yml) workflow publishes the same zip to **GitHub Releases** when you push a version tag:

```sh
# 1. Bump "version" in extension/manifest.json first
git tag v1.0.2
git push origin v1.0.2
```

The tag (`v1.0.2`) must match the manifest version (`1.0.2`). You can also run the workflow manually from the Actions tab; it uses the manifest version and creates the tag if needed.

## Local development

```sh
npm install
npm run dev          # wrangler dev — local Worker
npm run db:init      # apply schema.sql to local D1
npm run typecheck
npm run test:extension
npm run lint:firefox
```

Load the extension unpacked from `extension/` in `chrome://extensions` or Firefox `about:debugging`.
