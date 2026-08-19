// background.js — cross-browser background script (Chrome/Edge MV3 service
// worker, Firefox MV3 background script) via manifest.json's dual
// "service_worker" + "scripts" declaration.
//
// Listens for native browser bookmark creation and forwards each new
// bookmark to the Cloudflare Worker, which handles scraping + AI tagging
// asynchronously. This script's job is just: detect, dedupe junk, resolve a
// category from the bookmark's real folder path, POST, and record what
// happened to browser.storage.local so popup.js can show it.
//
// The toolbar icon opens popup.html (see manifest.json's action.default_popup)
// instead of firing action.onClicked directly — once a popup is set, MV3
// never fires onClicked at all. The popup's "Import" button sends a
// runtime message instead; see the onMessage listener below.

// Firefox loads browser-polyfill.js + config.js first via manifest "scripts"
// (a regular background page, not a worker — `importScripts` doesn't exist
// there). `importScripts` existing is what actually identifies the Chrome/
// Edge service worker context; checking `typeof browser === 'undefined'`
// instead would be wrong, since recent Chromium versions predefine a native
// `browser` global too.
if (typeof importScripts === 'function') {
  importScripts('browser-polyfill.js', 'config.js');
}

// WORKER_API_URL and API_TOKEN come from config.js (loaded above).

// No server-side rate limiting exists yet, and Browser Rendering/Workers AI
// both have concurrency limits — importing hundreds of bookmarks at once
// would fire that many scrape+tag pipelines simultaneously. Spacing requests
// out client-side keeps a bulk import from tripping either.
const IMPORT_DELAY_MS = 500;

// The POST itself should return fast — the Worker only does a DB insert/
// lookup before responding, deferring scrape/tag/categorize to a background
// waitUntil(). But the import loop processes one bookmark at a time and
// awaits each fetch fully, so a single hung request (bad network, a stalled
// connection, anything) would otherwise block the whole import indefinitely
// with no way to skip past it. Bounding it means a stuck request just counts
// as one failed sync instead of stalling everything after it.
const FETCH_TIMEOUT_MS = 20000;

const RECENT_ACTIVITY_LIMIT = 20;

const DEFAULT_SETTINGS = {
  // Off by default: AI categorization is an extra Workers AI call per unfiled
  // bookmark, so it's opt-in rather than assumed.
  suggestCategoryForUnfiled: false,
};

// How long to keep polling for an AI-assigned category after an unfiled
// live-create, before giving up quietly. NOTE: like the import loop, an MV3
// service worker can in principle be killed mid-poll if the browser decides
// it's been idle too long — the repeated fetch() calls are generally enough
// to keep it alive for this short a window, but it isn't bulletproof. If a
// notification never arrives, the category is still recorded server-side —
// see extension/library.js.
const CATEGORY_POLL_INTERVAL_MS = 2500;
const CATEGORY_POLL_MAX_ATTEMPTS = 6; // ~15s total

browser.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  if (!isSyncableUrl(bookmark.url)) {
    return;
  }

  const title = await resolveBestTitle(bookmark);
  const category = await resolveCategoryPath(bookmark.parentId);
  const result = await syncBookmark(bookmark.url, title, category);

  // Only notify for genuinely unfiled bookmarks where AI suggestion was
  // actually requested — a real folder always wins and never needs this,
  // and this is specifically about surfacing Ctrl+D's default "unfiled"
  // case, not every sync (a bulk import calls syncBookmark too, and firing
  // a notification per bookmark there would be spam).
  if (!category && result?.willSuggestCategory) {
    notifyWhenCategorized(result.id, title || bookmark.url).catch((err) =>
      console.error('[BookmarkSync] notifyWhenCategorized failed:', err)
    );
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'start-import') {
    importAllBookmarks().catch((err) => console.error('[BookmarkSync] Import failed:', err));
  }
});

browser.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('category-suggestion:')) return;
  const category = decodeURIComponent(notificationId.slice('category-suggestion:'.length));
  browser.tabs.create({
    url: browser.runtime.getURL(`library.html?category=${encodeURIComponent(category)}`),
  });
  browser.notifications.clear(notificationId);
});

async function notifyWhenCategorized(id, label) {
  for (let attempt = 0; attempt < CATEGORY_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(CATEGORY_POLL_INTERVAL_MS);

    const bookmark = await fetchBookmarkById(id);
    if (!bookmark) return; // network/auth error — already logged by fetchBookmarkById

    if (bookmark.category) {
      await showCategorySuggestionNotification(label, bookmark.category);
      return;
    }

    // Pipeline finished (tagged, possibly failed to find a fitting category)
    // — nothing more will change, stop polling instead of running out the clock.
    if (bookmark.status !== 'pending') {
      return;
    }
  }
}

async function fetchBookmarkById(id) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${WORKER_API_URL}/bookmarks/${id}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error('[BookmarkSync] Failed to poll bookmark status:', err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function showCategorySuggestionNotification(label, category) {
  await browser.notifications.create(`category-suggestion:${encodeURIComponent(category)}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon128.png'),
    title: 'Suggested category',
    message: `${label}\n→ ${category}`,
  });
}

async function importAllBookmarks() {
  const { syncState } = await browser.storage.local.get('syncState');
  if (syncState?.importRunning) {
    return; // Already running — the popup's button is disabled for this too.
  }

  const tree = await browser.bookmarks.getTree();
  const bookmarks = [];
  collectSyncableBookmarks(tree, bookmarks);

  // Fetched once up front so a re-import can skip any bookmark whose real
  // folder-derived category hasn't changed since last time, instead of
  // sending (and waiting IMPORT_DELAY_MS after) a POST for every single one
  // regardless of whether anything actually needs to change. A failed fetch
  // falls back to an empty map, which just means nothing gets skipped — the
  // same behavior as before this existed.
  const existingCategories = await fetchExistingCategoriesByUrl();

  console.log(`[BookmarkSync] Importing ${bookmarks.length} existing bookmark(s)...`);
  await setSyncState({ importRunning: true, importCurrent: 0, importTotal: bookmarks.length });

  let skipped = 0;

  // NOTE: an MV3 service worker can be terminated mid-loop if the browser
  // decides it's been idle too long. A live fetch is generally enough to
  // keep it alive, but for a very large bookmark library this isn't
  // bulletproof. If an import stalls, reopening the popup and clicking
  // Import again picks back up cheaply — already-synced URLs just get a
  // 200 from the dedupe check below instead of being reprocessed.
  for (let i = 0; i < bookmarks.length; i++) {
    const bookmark = bookmarks[i];
    const derivedCategory = bookmark.categoryPath || null;

    if (
      Object.prototype.hasOwnProperty.call(existingCategories, bookmark.url) &&
      existingCategories[bookmark.url] === derivedCategory
    ) {
      // Same category already stored for this URL — nothing would change,
      // so skip the POST (and the delay) entirely.
      skipped++;
    } else {
      const title = await resolveBestTitle(bookmark);
      await syncBookmark(bookmark.url, title, derivedCategory);
      await sleep(IMPORT_DELAY_MS);
    }

    await setSyncState({ importRunning: true, importCurrent: i + 1, importTotal: bookmarks.length });
  }

  console.log(
    `[BookmarkSync] Import complete: ${bookmarks.length - skipped} synced, ${skipped} unchanged and skipped.`
  );
  await setSyncState({ importRunning: false, importCurrent: bookmarks.length, importTotal: bookmarks.length });
}

// Returns a { [url]: category | null } map of every bookmark currently
// stored by the Worker, used by importAllBookmarks() to skip re-processing
// ones whose category wouldn't change. Returns {} (skip nothing) on failure,
// so a network hiccup here just falls back to the old always-sync behavior.
async function fetchExistingCategoriesByUrl() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${WORKER_API_URL}/bookmarks/url-categories`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) return {};
    const data = await response.json();
    return data.categories || {};
  } catch (err) {
    console.error('[BookmarkSync] Failed to fetch existing categories, importing everything:', err);
    return {};
  }
}

// Bookmark folders have no `url`; skip those. Also skip non-http(s) schemes
// (chrome://, file://, javascript:) since the Worker can't meaningfully
// scrape or search them.
function isSyncableUrl(url) {
  return Boolean(url) && /^https?:\/\//i.test(url);
}

// getTree()'s single root node's direct children are the browser's built-in
// containers (Chrome: "Bookmarks bar" / "Other bookmarks"; Firefox: "menu",
// "toolbar", "unfiled", ...) — not meaningful categories, so the category
// path starts one level below those, not at the very top of the tree.
function collectSyncableBookmarks(tree, out) {
  const containers = tree[0]?.children || [];
  for (const container of containers) {
    walkForSync(container.children || [], out, []);
  }
}

function walkForSync(nodes, out, pathSegments) {
  for (const node of nodes) {
    if (isSyncableUrl(node.url)) {
      out.push({ ...node, categoryPath: pathSegments.length ? pathSegments.join('/') : null });
    }
    if (node.children) {
      walkForSync(node.children, out, [...pathSegments, node.title]);
    }
  }
}

// Live-create equivalent of walkForSync's path-building, but starting from a
// single bookmark's parentId instead of a full tree walk — used by the
// bookmarks.onCreated listener. Walks up the parent chain, collecting folder
// titles, stopping before (not including) one of the browser's built-in
// top-level containers.
let topLevelContainerIdsPromise = null;

function getTopLevelContainerIds() {
  if (!topLevelContainerIdsPromise) {
    topLevelContainerIdsPromise = browser.bookmarks
      .getTree()
      .then((tree) => new Set((tree[0]?.children || []).map((node) => node.id)));
  }
  return topLevelContainerIdsPromise;
}

async function resolveCategoryPath(parentId) {
  const containerIds = await getTopLevelContainerIds();
  const segments = [];
  let currentId = parentId;

  while (currentId && !containerIds.has(currentId)) {
    const [node] = await browser.bookmarks.get(currentId).catch(() => [null]);
    if (!node) break;
    segments.unshift(node.title);
    currentId = node.parentId;
  }

  return segments.length ? segments.join('/') : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setSyncState(patch) {
  const { syncState } = await browser.storage.local.get('syncState');
  await browser.storage.local.set({ syncState: { ...syncState, ...patch } });
}

async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

// popup.js renders this list directly — status here reflects whether the
// Worker *accepted* the bookmark (POST succeeded), not whether its
// background scrape/tag pipeline has finished, which popup.js has no way to
// observe without polling a second endpoint.
//
// storage.local has no atomic append, so concurrent get-then-set calls (e.g.
// two bookmarks created back to back) can race and silently drop an entry.
// Chaining every call through one promise serializes them within this
// worker instance, which is enough since all writers live here.
let activityQueue = Promise.resolve();

function recordActivity(entry) {
  activityQueue = activityQueue
    .then(async () => {
      const { recentActivity = [] } = await browser.storage.local.get('recentActivity');
      const updated = [{ ...entry, timestamp: Date.now() }, ...recentActivity].slice(0, RECENT_ACTIVITY_LIMIT);
      await browser.storage.local.set({ recentActivity: updated });
    })
    .catch((err) => console.error('[BookmarkSync] recordActivity failed:', err));
  return activityQueue;
}

// Returns { id, willSuggestCategory } on success (willSuggestCategory is
// true when the Worker was asked to AI-classify this bookmark, i.e. it had
// no real folder and the setting is on — the caller uses this to decide
// whether polling for a notification is worthwhile), or null on failure.
async function syncBookmark(url, title, categoryPath) {
  try {
    const body = { url, title };
    let willSuggestCategory = false;

    if (categoryPath) {
      // A real folder path always wins — never ask the AI to guess when we
      // already know the answer.
      body.category = categoryPath;
    } else {
      const settings = await getSettings();
      if (settings.suggestCategoryForUnfiled) {
        body.suggestCategory = true;
        willSuggestCategory = true;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${WORKER_API_URL}/bookmarks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`[BookmarkSync] Worker responded ${response.status}: ${errorBody}`);
      await recordActivity({ url, title, category: categoryPath, status: 'failed' });
      return null;
    }

    const data = await response.json();
    console.log('[BookmarkSync] Synced bookmark:', data);
    await recordActivity({ url, title: title || url, category: categoryPath, status: 'synced' });
    // A dedupe hit (existing bookmark, response includes `message`) never
    // runs the classifier for THIS request even if suggestCategory was
    // sent — see bookmarks.ts. Only a fresh create (no `message`) actually
    // kicks off the background pipeline that might assign a category.
    return { id: data.id, willSuggestCategory: willSuggestCategory && !data.message };
  } catch (err) {
    // Network failure, worker down, timeout (AbortError), etc. The bookmark
    // still exists locally — it's just not synced to the backend this time.
    console.error('[BookmarkSync] Failed to reach Worker:', err);
    await recordActivity({ url, title, category: categoryPath, status: 'failed' });
    return null;
  }
}

/**
 * The bookmark object's `title` is sometimes empty (e.g. bookmarking a page
 * before it finished loading its <title>). Falls back to querying the open
 * tab matching this URL, using the `tabs` permission, for a better title
 * hint. The Worker's own scrape is still the source of truth — this is only
 * a placeholder shown until that finishes.
 */
async function resolveBestTitle(bookmark) {
  if (bookmark.title && bookmark.title.trim()) {
    return bookmark.title.trim();
  }

  try {
    const tabs = await browser.tabs.query({ url: bookmark.url });
    return tabs[0]?.title?.trim() || null;
  } catch {
    return null;
  }
}
