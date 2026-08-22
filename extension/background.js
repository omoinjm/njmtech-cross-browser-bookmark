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
  // On by default: an unfiled bookmark (no real folder, e.g. from Ctrl+D
  // into no folder, or the capture shortcut/context menu) should still end
  // up somewhere findable in the Library rather than sitting uncategorized
  // until manually filed. Costs one extra Workers AI call per unfiled
  // bookmark — still opt-out-able from the popup for anyone who'd rather
  // categorize by hand.
  suggestCategoryForUnfiled: true,
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

browser.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!isSyncableUrl(bookmark.url)) {
    return;
  }

  await rememberUrl(id, bookmark.url);

  // This create was triggered by writeNativeCreate() below, mirroring a
  // Library "Add" that already POSTed to the server directly — re-syncing
  // it here would just be a redundant (if harmless) round trip.
  if (consumeSelfWrite(bookmark.url)) return;

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

// Recursively finds every syncable {id, url} under a removed node — a
// removed folder's `removeInfo.node` includes its full former subtree, so
// deleting a whole folder needs every descendant bookmark's url, not just
// the folder itself (which has no url of its own).
function collectRemovedEntries(node, out = []) {
  if (!node) return out;
  if (isSyncableUrl(node.url)) out.push({ id: node.id, url: node.url });
  if (node.children) {
    for (const child of node.children) collectRemovedEntries(child, out);
  }
  return out;
}

browser.bookmarks.onRemoved.addListener(async (_id, removeInfo) => {
  for (const entry of collectRemovedEntries(removeInfo.node)) {
    // Triggered by writeNativeDelete() below, mirroring a Library "Delete"
    // that already called DELETE on the server directly.
    if (!consumeSelfWrite(entry.url)) {
      await deleteBookmark(entry.url);
    }
    await forgetUrl(entry.id);
  }
});

// Handles title edits and url edits (the two things bookmarks.onChanged
// fires for). Folder moves are onMoved's job below, not this listener's.
//
// NOTE: renaming a *folder* changes the effective category of every
// bookmark inside it, but neither onChanged nor onMoved fires for those
// descendants — only for the folder node itself, which was never url-
// tracked (folders have no url) and so is silently ignored here. That drift
// only self-heals via a full re-import for now; a targeted fix would need to
// walk the folder's current children on its own onChanged and resolve+patch
// each one's category.
browser.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  const previousUrl = await lookupUrl(id);

  if (changeInfo.url && changeInfo.url !== previousUrl) {
    // The identity key itself changed — this is a different resource
    // server-side (a fresh url to scrape+tag), not an in-place edit.
    if (previousUrl) await deleteBookmark(previousUrl);

    if (!isSyncableUrl(changeInfo.url)) {
      await forgetUrl(id);
      return;
    }

    const [node] = await browser.bookmarks.get(id).catch(() => [null]);
    if (!node) return;

    await rememberUrl(id, node.url);
    const title = await resolveBestTitle(node);
    const category = await resolveCategoryPath(node.parentId);
    await syncBookmark(node.url, title, category);
    return;
  }

  if (!previousUrl) return; // untracked (not syncable, or map missing this id)

  // Triggered by writeNativeUpdate() below, mirroring a Library title edit
  // that already PATCHed the server directly.
  if (consumeSelfWrite(previousUrl)) return;

  if (changeInfo.title !== undefined) {
    await patchBookmark(previousUrl, { title: changeInfo.title || null });
  }
});

// Fires when a bookmark moves between folders — its url is unchanged, only
// its real folder path (and therefore its derived category) is.
browser.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  const url = await lookupUrl(id);
  if (!url) return; // untracked (e.g. a folder was moved, not a bookmark)

  // Triggered by writeNativeUpdate() below, mirroring a Library category
  // edit that already PATCHed the server directly.
  if (consumeSelfWrite(url)) return;

  const category = await resolveCategoryPath(moveInfo.parentId);
  await patchBookmark(url, { category });
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'start-import') {
    importAllBookmarks().catch((err) => console.error('[BookmarkSync] Import failed:', err));
  } else if (message?.type === 'import-entries') {
    importFromEntries(message.entries || []).catch((err) =>
      console.error('[BookmarkSync] File import failed:', err)
    );
  } else if (message?.type === 'native-create') {
    queueNativeWrite(() => writeNativeCreate(message.url, message.title, message.category));
  } else if (message?.type === 'native-update') {
    queueNativeWrite(() => writeNativeUpdate(message.url, message.title, message.category));
  } else if (message?.type === 'native-delete') {
    queueNativeWrite(() => writeNativeDelete(message.url));
  }
});

// --- Capture beyond Ctrl+D (Phase 6) ---
//
// Two more ways to get a page into the Library without ever touching a
// native bookmark folder: a right-click context menu entry, and a keyboard
// shortcut for the current tab. Both funnel through captureUrl, which is
// Library-only — deliberately NOT mirrored into native bookmarks the way a
// Library "Add" is (see writeNativeCreate) — this is meant as a purely
// native-independent capture path.
browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: 'save-to-library',
    title: 'Save to Library',
    contexts: ['page', 'link'],
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-to-library') return;

  // Right-clicking a link has no reliable "link text" field to fall back
  // on (unlike a page, which has tab.title) — captureUrl's resolveBestTitle
  // call already handles a missing title by trying an open tab, and the
  // Worker's own scrape fills it in properly regardless.
  const isLink = Boolean(info.linkUrl);
  const url = isLink ? info.linkUrl : info.pageUrl;
  const title = isLink ? null : tab?.title || null;

  captureUrl(url, title).catch((err) => console.error('[BookmarkSync] Context menu save failed:', err));
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-current-tab') return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  captureUrl(tab.url, tab.title).catch((err) => console.error('[BookmarkSync] Save-current-tab failed:', err));
});

async function captureUrl(url, title) {
  if (!isSyncableUrl(url)) return;

  const resolvedTitle = await resolveBestTitle({ title, url });
  const result = await syncBookmark(url, resolvedTitle, null);

  // Unlike Ctrl+D (which gets the browser's own native "bookmarked" star
  // feedback), a context-menu/shortcut capture has no built-in confirmation
  // — this is the only signal the user gets that it actually worked.
  await browser.notifications.create(`captured:${encodeURIComponent(url)}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon128.png'),
    title: 'Saved to Library',
    message: resolvedTitle || url,
  });

  if (result?.willSuggestCategory) {
    notifyWhenCategorized(result.id, resolvedTitle || url).catch((err) =>
      console.error('[BookmarkSync] notifyWhenCategorized failed:', err)
    );
  }
}

// --- Omnibox: type "lib <query>" in the address bar (Phase 6) ---
//
// Reinforces the Library as the actual day-to-day way to find a bookmark
// (this project's whole point — see the memory note on replacing native
// bookmark browsing) instead of digging through folders. Picking a
// suggestion jumps straight to that bookmark; plain Enter opens the full
// Library pre-filled with the typed query.
const OMNIBOX_SUGGESTION_LIMIT = 5;

browser.omnibox.setDefaultSuggestion({
  description: 'Search your bookmark Library',
});

browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const query = text.trim();
  if (!query) {
    suggest([]);
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${WORKER_API_URL}/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: controller.signal,
    });
    if (!response.ok) return;

    const data = await response.json();
    const results = (data.results || []).slice(0, OMNIBOX_SUGGESTION_LIMIT);

    suggest(
      results.map((bookmark) => ({
        content: bookmark.url,
        // The omnibox suggestion API renders `description` as a small XML
        // dialect (<match>/<dim>), so untrusted title/url text needs entity
        // escaping here — otherwise a bookmark title containing `<` or `&`
        // could corrupt the suggestion markup itself.
        description: `${escapeOmniboxXml(bookmark.title || bookmark.url)} — <dim>${escapeOmniboxXml(bookmark.url)}</dim>`,
      }))
    );
  } catch (err) {
    console.error('[BookmarkSync] Omnibox search failed:', err);
  } finally {
    clearTimeout(timeoutId);
  }
});

browser.omnibox.onInputEntered.addListener((text, disposition) => {
  // A url-shaped entry came from picking one of our own suggestions above —
  // go straight there. Anything else (free text, or Enter with no
  // suggestion picked) opens the full Library search instead.
  const destination = isSyncableUrl(text)
    ? text
    : browser.runtime.getURL(`library.html?search=${encodeURIComponent(text)}`);

  if (disposition === 'currentTab') {
    browser.tabs.update({ url: destination });
  } else {
    browser.tabs.create({ url: destination });
  }
});

function escapeOmniboxXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  const tree = await browser.bookmarks.getTree();
  const bookmarks = [];
  collectSyncableBookmarks(tree, bookmarks);

  // So a later onRemoved/onChanged/onMoved for any of these ids can resolve
  // its url without having gone through onCreated first (true for every
  // bookmark that predates this extension's install).
  await rememberUrls(bookmarks.map((bookmark) => [bookmark.id, bookmark.url]));

  // Title resolution is deferred to runImport's per-entry resolveTitle hook
  // (see its doc comment) so a re-import can skip the tabs.query lookup
  // entirely for every bookmark whose category didn't change.
  await runImport(
    bookmarks.map((bookmark) => ({
      url: bookmark.url,
      categoryPath: bookmark.categoryPath,
      resolveTitle: () => resolveBestTitle(bookmark),
    }))
  );
}

// Mirrors importAllBookmarks above, but for bookmarks parsed from an
// uploaded Netscape bookmarks.html file (library.js's Import file button)
// instead of this browser's live bookmark tree — see parseNetscapeBookmarksHtml.
// Shares the same runImport core, so it gets the same progress tracking
// (the Library page's #import-banner already listens for this),
// throttling, and "skip if category unchanged" dedupe for free.
async function importFromEntries(entries) {
  await runImport(
    entries.map((entry) => ({
      url: entry.url,
      categoryPath: entry.category,
      resolveTitle: async () => entry.title || null,
    }))
  );
}

// Shared core for both import entry points above. `entries` is
// [{ url, categoryPath, resolveTitle }] — resolveTitle is only called for
// entries that aren't skipped by the unchanged-category check below, since
// for the native path it costs a browser.tabs.query call per bookmark.
async function runImport(entries) {
  const { syncState } = await browser.storage.local.get('syncState');
  if (syncState?.importRunning) {
    return; // Already running — the popup's button is disabled for this too.
  }

  // Fetched once up front so a re-import can skip any bookmark whose real
  // folder-derived category hasn't changed since last time, instead of
  // sending (and waiting IMPORT_DELAY_MS after) a POST for every single one
  // regardless of whether anything actually needs to change. A failed fetch
  // falls back to an empty map, which just means nothing gets skipped — the
  // same behavior as before this existed.
  const existingCategories = await fetchExistingCategoriesByUrl();

  console.log(`[BookmarkSync] Importing ${entries.length} bookmark(s)...`);
  await setSyncState({ importRunning: true, importCurrent: 0, importTotal: entries.length });

  let skipped = 0;

  // NOTE: an MV3 service worker can be terminated mid-loop if the browser
  // decides it's been idle too long. A live fetch is generally enough to
  // keep it alive, but for a very large bookmark library this isn't
  // bulletproof. If an import stalls, reopening the popup and clicking
  // Import again picks back up cheaply — already-synced URLs just get a
  // 200 from the dedupe check below instead of being reprocessed.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const derivedCategory = entry.categoryPath || null;

    if (
      Object.prototype.hasOwnProperty.call(existingCategories, entry.url) &&
      existingCategories[entry.url] === derivedCategory
    ) {
      // Same category already stored for this URL — nothing would change,
      // so skip the POST (and the delay) entirely.
      skipped++;
    } else {
      const title = await entry.resolveTitle();
      await syncBookmark(entry.url, title, derivedCategory);
      await sleep(IMPORT_DELAY_MS);
    }

    await setSyncState({ importRunning: true, importCurrent: i + 1, importTotal: entries.length });
  }

  console.log(
    `[BookmarkSync] Import complete: ${entries.length - skipped} synced, ${skipped} unchanged and skipped.`
  );
  await setSyncState({ importRunning: false, importCurrent: entries.length, importTotal: entries.length });
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
let topLevelContainersPromise = null;

function getTopLevelContainers() {
  if (!topLevelContainersPromise) {
    topLevelContainersPromise = browser.bookmarks.getTree().then((tree) => tree[0]?.children || []);
  }
  return topLevelContainersPromise;
}

function getTopLevelContainerIds() {
  return getTopLevelContainers().then((containers) => new Set(containers.map((node) => node.id)));
}

// Where a Library-initiated native create/move lands when it has no category
// (or one whose leading segment doesn't yet exist as a folder). There's no
// WebExtensions API for "give me the unfiled/other-bookmarks container" —
// Firefox's has a stable id across profiles, Chrome/Edge's don't (they're
// just small integers), so this falls back to matching the title Chrome/Edge
// use by convention, and finally to whichever top-level container is first.
async function getDefaultParentId() {
  const containers = await getTopLevelContainers();
  const firefoxOther = containers.find((c) => c.id === 'unfiled_____');
  if (firefoxOther) return firefoxOther.id;
  const chromeOther = containers.find((c) => /other/i.test(c.title));
  if (chromeOther) return chromeOther.id;
  return containers[0]?.id;
}

// Finds (or creates) the folder chain a "Dev Tools/AI APIs"-style category
// path maps to, returning the deepest folder's id. Mirrors the inverse of
// resolveCategoryPath above.
async function resolveOrCreateFolderId(categoryPath) {
  let parentId = await getDefaultParentId();
  if (!categoryPath) return parentId;

  for (const segment of categoryPath.split('/').filter(Boolean)) {
    const children = await browser.bookmarks.getChildren(parentId);
    const existing = children.find((child) => !child.url && child.title === segment);
    parentId = existing ? existing.id : (await browser.bookmarks.create({ parentId, title: segment })).id;
  }

  return parentId;
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

// The Worker keys bookmarks by url (its dedupe key, and the thing that must
// be shared across browsers for cross-browser sync to mean anything), never
// by this browser's native bookmark id. But onChanged/onMoved/onRemoved only
// hand back a native id — this map is the local, per-install bridge from
// that id to the url it last pointed at, so those listeners can tell the
// Worker *which* bookmark to patch/delete. It's best-effort: a missing entry
// (fresh install, cleared storage) just means that one edit gets silently
// dropped instead of applied, self-healing on the next full re-import.
//
// Same race as recordActivity above (storage.local has no atomic
// read-modify-write) — serialized through one promise chain for the same
// reason.
let urlMapQueue = Promise.resolve();

function queueUrlMapTask(task) {
  urlMapQueue = urlMapQueue
    .then(async () => {
      const { nativeBookmarkUrls = {} } = await browser.storage.local.get('nativeBookmarkUrls');
      return task(nativeBookmarkUrls);
    })
    .catch((err) => {
      console.error('[BookmarkSync] url map operation failed:', err);
      return null;
    });
  return urlMapQueue;
}

function rememberUrl(id, url) {
  return queueUrlMapTask(async (map) => {
    map[id] = url;
    await browser.storage.local.set({ nativeBookmarkUrls: map });
  });
}

function rememberUrls(idUrlPairs) {
  return queueUrlMapTask(async (map) => {
    for (const [id, url] of idUrlPairs) map[id] = url;
    await browser.storage.local.set({ nativeBookmarkUrls: map });
  });
}

// Removes and returns the mapped url (or null if this id had none).
function forgetUrl(id) {
  return queueUrlMapTask(async (map) => {
    const url = map[id] ?? null;
    if (url !== null) {
      delete map[id];
      await browser.storage.local.set({ nativeBookmarkUrls: map });
    }
    return url;
  });
}

function lookupUrl(id) {
  return queueUrlMapTask((map) => map[id] ?? null);
}

// --- Native write-back (Phase 3) ---
//
// library.js's Add/Edit/Delete already talk to the Worker directly (see its
// apiPost/apiPatch/apiDelete) — these mirror that same change into this
// browser's native bookmarks afterward, via a runtime message, so the
// browser's own star icon / bookmarks bar doesn't drift from the Library.
//
// Self-write guard: each native mutation below is expected to fire exactly
// one of onCreated/onChanged/onMoved/onRemoved right back at this same
// script. Without tracking that, those listeners would re-sync the "new"
// state to the Worker — harmless (it's already current there) but a wasted
// round trip, and for onCreated specifically it would also re-run the
// dedupe/category logic for no reason. markSelfWrite records exactly one
// expected event per url per anticipated listener; consumeSelfWrite lets
// that one specific listener invocation swallow it. A TTL-based fallback
// expiry guards against the (rare) case a service worker restart drops the
// in-memory Set between the write and its event — the worst case then is
// just one redundant, idempotent sync back to the Worker.
const SELF_WRITE_TTL_MS = 5000;
const pendingSelfWrites = new Map();

function markSelfWrite(url) {
  pendingSelfWrites.set(url, (pendingSelfWrites.get(url) || 0) + 1);
  setTimeout(() => {
    const count = pendingSelfWrites.get(url);
    if (count === undefined) return;
    if (count <= 1) pendingSelfWrites.delete(url);
    else pendingSelfWrites.set(url, count - 1);
  }, SELF_WRITE_TTL_MS);
}

function consumeSelfWrite(url) {
  const count = pendingSelfWrites.get(url);
  if (!count) return false;
  if (count <= 1) pendingSelfWrites.delete(url);
  else pendingSelfWrites.set(url, count - 1);
  return true;
}

// Serializes native writes so two Library actions in quick succession (e.g.
// two edits into new categories) can't race on resolveOrCreateFolderId and
// create duplicate folders for the same path.
let nativeWriteQueue = Promise.resolve();

function queueNativeWrite(task) {
  nativeWriteQueue = nativeWriteQueue.then(task).catch((err) => {
    console.error('[BookmarkSync] Native write failed:', err);
  });
  return nativeWriteQueue;
}

// Mirrors a Library "Add". If this url is already natively bookmarked here
// (e.g. added from the Library once before, or bookmarked in this browser
// separately), realigns that instead of creating a duplicate.
async function writeNativeCreate(url, title, category) {
  const existing = await browser.bookmarks.search({ url });
  if (existing.length > 0) {
    await writeNativeUpdate(url, title, category);
    return;
  }

  const parentId = await resolveOrCreateFolderId(category);
  markSelfWrite(url);
  await browser.bookmarks.create({ parentId, title: title || url, url });
}

// Mirrors a Library title/category edit. Only touches a native bookmark
// that already exists for this url — a Library-only bookmark stays
// Library-only until something explicitly Adds it natively.
async function writeNativeUpdate(url, title, category) {
  const nodes = await browser.bookmarks.search({ url });
  if (nodes.length === 0) return;

  const parentId = await resolveOrCreateFolderId(category);

  for (const node of nodes) {
    const titleChanging = Boolean(title) && node.title !== title;
    const parentChanging = node.parentId !== parentId;

    if (titleChanging) {
      markSelfWrite(url); // consumed by onChanged
      await browser.bookmarks.update(node.id, { title });
    }
    if (parentChanging) {
      markSelfWrite(url); // consumed by onMoved
      await browser.bookmarks.move(node.id, { parentId });
    }
  }
}

// Mirrors a Library delete — removes every native bookmark for this url in
// this browser, if any.
async function writeNativeDelete(url) {
  const nodes = await browser.bookmarks.search({ url });
  for (const node of nodes) {
    markSelfWrite(url);
    await browser.bookmarks.remove(node.id);
  }
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

// Used by onChanged (title edits) and onMoved (category, from a folder
// move). A 404 means the Worker never had this url in the first place
// (e.g. it failed to sync originally) — not an error worth logging, since
// there's nothing to patch either way.
async function patchBookmark(url, fields) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${WORKER_API_URL}/bookmarks?url=${encodeURIComponent(url)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify(fields),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok && response.status !== 404) {
      console.error(`[BookmarkSync] Patch failed for ${url}: ${response.status}`);
    }
  } catch (err) {
    console.error('[BookmarkSync] Failed to patch bookmark:', err);
  }
}

// Used by onRemoved. Same 404-is-fine reasoning as patchBookmark above.
async function deleteBookmark(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${WORKER_API_URL}/bookmarks?url=${encodeURIComponent(url)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok && response.status !== 404) {
      console.error(`[BookmarkSync] Delete failed for ${url}: ${response.status}`);
    }
  } catch (err) {
    console.error('[BookmarkSync] Failed to delete bookmark:', err);
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
