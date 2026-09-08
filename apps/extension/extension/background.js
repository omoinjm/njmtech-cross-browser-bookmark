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
  importScripts('browser-polyfill.js', 'config.js', 'api-client.js');
}

// getSessionToken/getActiveProfile/apiGet/apiPost/apiPatch/apiDelete/
// resolveActiveProfile/FETCH_TIMEOUT_MS all come from api-client.js (loaded
// above), which also folds in the session token and X-Profile-Id headers —
// see that file for details.

// No server-side rate limiting exists yet, and Browser Rendering/Workers AI
// both have concurrency limits — importing hundreds of bookmarks at once
// would fire that many scrape+tag pipelines simultaneously. Spacing requests
// out client-side keeps a bulk import from tripping either.
const IMPORT_DELAY_MS = 500;

// The import loop processes one bookmark at a time and awaits each request
// fully, so a single hung request (bad network, a stalled connection,
// anything) would otherwise block the whole import indefinitely with no way
// to skip past it — api-client.js's FETCH_TIMEOUT_MS bounds every request
// made through apiGet/apiPost/apiPatch/apiDelete, so a stuck request just
// counts as one failed sync instead of stalling everything after it.

const RECENT_ACTIVITY_LIMIT = 20;

// --- Offline / logged-out queueing ---
//
// A capture attempted while logged out or with the Worker unreachable would
// otherwise just be lost (recorded as "failed" and never retried). Instead
// it's kept here and retried once there's a valid session and the Worker
// responds again — on login, on a periodic alarm (for the unattended
// "network came back on its own" case), and opportunistically right after
// any other capture succeeds.
const PENDING_BOOKMARKS_KEY = 'pendingBookmarks';
const PENDING_BOOKMARKS_LIMIT = 500; // bounds storage.local growth over a long offline stretch
const QUEUE_RETRY_ALARM = 'flush-pending-bookmarks';
const QUEUE_RETRY_INTERVAL_MINUTES = 2;

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

  browser.alarms.create(QUEUE_RETRY_ALARM, { periodInMinutes: QUEUE_RETRY_INTERVAL_MINUTES });
});

// onInstalled only fires on install/update, not on every browser launch —
// alarms do persist across restarts on their own, but re-creating here
// (idempotent — same name just resets its schedule) plus an immediate flush
// attempt covers "the computer was offline overnight and came back online
// right as the browser started", not just "still running when the alarm ticks".
browser.runtime.onStartup.addListener(() => {
  browser.alarms.create(QUEUE_RETRY_ALARM, { periodInMinutes: QUEUE_RETRY_INTERVAL_MINUTES });
  flushPendingBookmarks().catch((err) => console.error('[BookmarkSync] Startup flush failed:', err));
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== QUEUE_RETRY_ALARM) return;
  flushPendingBookmarks().catch((err) => console.error('[BookmarkSync] Periodic flush failed:', err));
});

// The other trigger besides connectivity: logging back in. Fires only on
// the false->truthy transition (a fresh login), not on every storage write
// that happens to include this key.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sessionToken && !changes.sessionToken.oldValue && changes.sessionToken.newValue) {
    flushPendingBookmarks().catch((err) => console.error('[BookmarkSync] Post-login flush failed:', err));
  }
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
  if (command === 'save-current-tab') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    captureUrl(tab.url, tab.title).catch((err) => console.error('[BookmarkSync] Save-current-tab failed:', err));
    return;
  }

  if (command === 'open-search-tab') {
    // openPopup() only works while the shortcut's user gesture is still
    // "live" — Chrome drops that as soon as this listener awaits anything,
    // so it must be the very first call kicked off here, with no await in
    // front of it. Popup.js reads pendingPopupTab on init and switches
    // straight to the Search tab (openPopup() takes no arguments, so
    // storage is the only way to tell it which tab the shortcut meant).
    const openPromise = browser.action.openPopup();
    try {
      await browser.storage.local.set({ pendingPopupTab: 'search' });
      await openPromise;
    } catch (err) {
      console.error('[BookmarkSync] Open-search-tab failed:', err);
    }
  }
});

async function captureUrl(url, title) {
  if (!isSyncableUrl(url)) return;

  const resolvedTitle = await resolveBestTitle({ title, url });
  const result = await syncBookmark(url, resolvedTitle, null);

  // Unlike Ctrl+D (which gets the browser's own native "bookmarked" star
  // feedback), a context-menu/shortcut capture has no built-in confirmation
  // — this is the only signal the user gets that it actually worked. The id
  // must be unique per capture, not just per url: reusing the same id for a
  // repeat capture of the same page makes this an in-place *update* to a
  // notification the user may have already dismissed, which most desktop
  // notification systems don't re-surface as a new toast.
  await browser.notifications.create(`captured:${Date.now()}:${encodeURIComponent(url)}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon128.png'),
    title: result?.queued ? 'Queued — will save once online' : 'Saved to Library',
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

  try {
    const data = await apiGet(`/search?q=${encodeURIComponent(query)}`);
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
  try {
    return await apiGet(`/bookmarks/${id}`);
  } catch (err) {
    console.error('[BookmarkSync] Failed to poll bookmark status:', err);
    return null;
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
    const data = await apiGet('/bookmarks/url-categories');
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
// Firefox's has a stable id across browser installs (not to be confused with
// a Library Profile — this is the OS-level "which Firefox user account"
// concept), Chrome/Edge's don't (they're just small integers), so this falls
// back to matching the title Chrome/Edge use by convention, and finally to
// whichever top-level container is first.
async function getDefaultParentId() {
  const containers = await getTopLevelContainers();
  const firefoxOther = containers.find((c) => c.id === 'unfiled_____');
  if (firefoxOther) return firefoxOther.id;
  const chromeOther = containers.find((c) => /other/i.test(c.title));
  if (chromeOther) return chromeOther.id;
  return containers[0]?.id;
}

function findChildFolder(children, title) {
  return children.find((child) => !child.url && child.title === title) || null;
}

// Each Library Profile ("Personal", "Work", ...) gets its own top-level
// native folder directly under the browser's real default container, so two
// profiles' category trees never collide even if they happen to use the
// same category names. Memoized by name as a Promise (not a resolved id),
// same rationale as topLevelContainersPromise above — concurrent native
// writes for the same profile must never race into creating the folder
// twice. Not invalidated on profile rename: this deliberately does NOT
// rename the native folder to match (see writeNativeCreate's doc comment on
// why native bookmarks predating a change are left alone) — a renamed
// profile keeps mirroring into its original-named native folder.
const profileRootFolderIds = new Map();

function getProfileRootFolderId(profileName) {
  if (!profileRootFolderIds.has(profileName)) {
    profileRootFolderIds.set(
      profileName,
      (async () => {
        const parentId = await getDefaultParentId();
        const existing = findChildFolder(await browser.bookmarks.getChildren(parentId), profileName);
        return existing ? existing.id : (await browser.bookmarks.create({ parentId, title: profileName })).id;
      })()
    );
  }
  return profileRootFolderIds.get(profileName);
}

// Read-only counterpart to getProfileRootFolderId above — never creates the
// folder. Used by resolveCategoryPath and the writeNative*'s cross-profile
// existence check below, both of which run for every native bookmark event
// (including ones with nothing to do with this extension) and must not have
// the side effect of conjuring a profile's folder into existence just from
// looking at an unrelated bookmark.
async function findProfileRootFolderId(profileName) {
  const parentId = await getDefaultParentId();
  const existing = findChildFolder(await browser.bookmarks.getChildren(parentId), profileName);
  return existing?.id ?? null;
}

// Finds (or creates) the folder chain a "Dev Tools/AI APIs"-style category
// path maps to, rooted under the currently active Library Profile's own
// native folder, returning the deepest folder's id. Mirrors the inverse of
// resolveCategoryPath below. Falls back to the browser's plain default
// container when no active profile is known yet (e.g. the very first popup/
// library load before resolveActiveProfile() has ever run) — same
// no-profile-info-yet safety net as api-client.js omitting X-Profile-Id.
async function resolveOrCreateFolderId(categoryPath) {
  const activeProfile = await getActiveProfile();
  let parentId = activeProfile ? await getProfileRootFolderId(activeProfile.name) : await getDefaultParentId();
  if (!categoryPath) return parentId;

  for (const segment of categoryPath.split('/').filter(Boolean)) {
    const children = await browser.bookmarks.getChildren(parentId);
    const existing = findChildFolder(children, segment);
    parentId = existing ? existing.id : (await browser.bookmarks.create({ parentId, title: segment })).id;
  }

  return parentId;
}

// Derives a category path by walking up from a native bookmark's parent
// folder, stopping at (not including) either one of the browser's built-in
// top-level containers OR the active Library Profile's own root folder —
// without that second stopping point, a bookmark nested under
// "Personal/Dev Tools/AI" would derive the category "Personal/Dev Tools/AI"
// instead of "Dev Tools/AI", double-counting the profile folder our own
// mirroring created. Uses the non-creating findProfileRootFolderId since
// this runs passively for every native bookmark event.
async function resolveCategoryPath(parentId) {
  const containerIds = await getTopLevelContainerIds();
  const activeProfile = await getActiveProfile();
  const profileRootId = activeProfile ? await findProfileRootFolderId(activeProfile.name) : null;
  const segments = [];
  let currentId = parentId;

  while (currentId && !containerIds.has(currentId) && currentId !== profileRootId) {
    const [node] = await browser.bookmarks.get(currentId).catch(() => [null]);
    if (!node) break;
    segments.unshift(node.title);
    currentId = node.parentId;
  }

  return segments.length ? segments.join('/') : null;
}

// Filters a browser.bookmarks.search({url}) result down to nodes actually
// nested under `folderId` — used by writeNativeCreate/Update/Delete below so
// a URL mirrored under one Library Profile's native folder is never mistaken
// for (or accidentally edited/deleted alongside) the same URL mirrored under
// a DIFFERENT profile's folder. `folderId` of null (the profile's native
// folder doesn't exist yet) correctly yields no matches — nothing could be
// nested under a folder that was never created.
async function filterNodesUnderFolder(nodes, folderId) {
  if (!folderId) return [];

  const kept = [];
  for (const node of nodes) {
    let currentId = node.id;
    while (currentId) {
      if (currentId === folderId) {
        kept.push(node);
        break;
      }
      const [parent] = await browser.bookmarks.get(currentId).catch(() => [null]);
      currentId = parent?.parentId;
    }
  }
  return kept;
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

// Every writeNative* below only ever acts on the active Library Profile's
// own native folder subtree — a plain browser.bookmarks.search({url}) finds
// a URL anywhere in the whole native tree, which would misfire once two
// profiles can each mirror the same URL into their own separate folder
// (mistaking one profile's copy for "this profile already has it", or
// editing/deleting every profile's copy instead of just the active one's).
async function searchWithinActiveProfile(url) {
  const activeProfile = await getActiveProfile();
  const profileRootId = activeProfile ? await findProfileRootFolderId(activeProfile.name) : null;
  return filterNodesUnderFolder(await browser.bookmarks.search({ url }), profileRootId);
}

// Mirrors a Library "Add". If this url is already natively bookmarked here,
// within the active profile's own folder (e.g. added from the Library once
// before, or bookmarked in this browser separately), realigns that instead
// of creating a duplicate.
async function writeNativeCreate(url, title, category) {
  const existing = await searchWithinActiveProfile(url);
  if (existing.length > 0) {
    await writeNativeUpdate(url, title, category);
    return;
  }

  const parentId = await resolveOrCreateFolderId(category);
  markSelfWrite(url);
  await browser.bookmarks.create({ parentId, title: title || url, url });
}

// Mirrors a Library title/category edit. Only touches a native bookmark
// that already exists for this url within the active profile's own folder —
// a Library-only bookmark stays Library-only until something explicitly
// Adds it natively, and a different profile's native copy of the same URL
// is left untouched.
async function writeNativeUpdate(url, title, category) {
  const nodes = await searchWithinActiveProfile(url);
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

// Mirrors a Library delete — removes every native bookmark for this url
// within the active profile's own folder in this browser, if any. A
// different profile's native copy of the same URL is left untouched.
async function writeNativeDelete(url) {
  const nodes = await searchWithinActiveProfile(url);
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

// The actual POST attempt, shared by syncBookmark (a fresh capture) and
// flushPendingBookmarks (a retry of something queued earlier). Returns one of:
//   { synced: true, id, willSuggestCategory }  — the Worker accepted it
//   { synced: false, retryable: true }         — no session, the Worker was
//                                                 unreachable, or the session
//                                                 turned out to be expired/
//                                                 invalid (401): the same
//                                                 remedy for all three is
//                                                 "try again once logged in
//                                                 and online", so the caller
//                                                 queues it
//   { synced: false, retryable: false }        — a real rejection (already
//                                                 logged + recorded as failed)
async function attemptSync(url, title, categoryPath) {
  const sessionToken = await getSessionToken();
  if (!sessionToken) {
    return { synced: false, retryable: true };
  }

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

  let data;
  try {
    data = await apiPost('/bookmarks', body);
  } catch (err) {
    if (err.status === undefined) {
      // Network failure, Worker unreachable, timeout, etc. — exactly the
      // "internet isn't working" case, distinct from a real rejection below.
      console.error('[BookmarkSync] Failed to reach Worker:', err);
      return { synced: false, retryable: true };
    }

    if (err.status === 401) {
      // Session expired/invalid server-side — same fix as not being logged
      // in at all: retry once there's a valid session again.
      return { synced: false, retryable: true };
    }

    console.error(`[BookmarkSync] Worker responded ${err.status}: ${err.message}`);
    await recordActivity({ url, title, category: categoryPath, status: 'failed' });
    return { synced: false, retryable: false };
  }

  console.log('[BookmarkSync] Synced bookmark:', data);
  await recordActivity({ url, title: title || url, category: categoryPath, status: 'synced' });
  // A dedupe hit (existing bookmark, response includes `message`) never
  // runs the classifier for THIS request even if suggestCategory was
  // sent — see bookmarks.ts. Only a fresh create (no `message`) actually
  // kicks off the background pipeline that might assign a category.
  return { synced: true, id: data.id, willSuggestCategory: willSuggestCategory && !data.message };
}

// Returns { id, willSuggestCategory } if actually synced, { queued: true } if
// queued for a later retry (see attemptSync's retryable cases above), or
// null if the Worker rejected it outright.
async function syncBookmark(url, title, categoryPath) {
  const result = await attemptSync(url, title, categoryPath);

  if (result.synced) {
    // Proves login + connectivity are both fine right now — a good moment to
    // also retry anything still queued from earlier, instead of waiting for
    // the next alarm tick.
    flushPendingBookmarks().catch((err) => console.error('[BookmarkSync] Opportunistic flush failed:', err));
    return { id: result.id, willSuggestCategory: result.willSuggestCategory };
  }

  if (result.retryable) {
    await queueBookmark(url, title, categoryPath);
    return { queued: true };
  }

  return null;
}

// Queues a capture that couldn't go out right now. Replaces any existing
// queued entry for the same url instead of piling up duplicates (e.g. a
// title edit while still offline) — the latest attempt wins.
async function queueBookmark(url, title, categoryPath) {
  const { [PENDING_BOOKMARKS_KEY]: pending = [] } = await browser.storage.local.get(PENDING_BOOKMARKS_KEY);
  const deduped = pending.filter((item) => item.url !== url);
  deduped.push({ url, title, category: categoryPath, queuedAt: Date.now() });
  await browser.storage.local.set({ [PENDING_BOOKMARKS_KEY]: deduped.slice(-PENDING_BOOKMARKS_LIMIT) });
  await recordActivity({ url, title, category: categoryPath, status: 'queued' });
}

// Retries every queued capture — called on login, periodically via an alarm,
// and opportunistically after any other capture succeeds (see syncBookmark).
// A no-op whenever there's nothing queued or still no session to use.
let isFlushingPendingBookmarks = false;

async function flushPendingBookmarks() {
  if (isFlushingPendingBookmarks) return; // avoid overlapping flushes racing each other

  const sessionToken = await getSessionToken();
  if (!sessionToken) return;

  const { [PENDING_BOOKMARKS_KEY]: pending = [] } = await browser.storage.local.get(PENDING_BOOKMARKS_KEY);
  if (pending.length === 0) return;

  isFlushingPendingBookmarks = true;
  try {
    const stillPending = [];

    for (const item of pending) {
      const result = await attemptSync(item.url, item.title, item.category);

      if (result.synced) {
        if (result.willSuggestCategory) {
          notifyWhenCategorized(result.id, item.title || item.url).catch((err) =>
            console.error('[BookmarkSync] notifyWhenCategorized failed:', err)
          );
        }
      } else if (result.retryable) {
        stillPending.push(item); // still offline/logged-out — try again next time
      }
      // A non-retryable rejection is dropped — attemptSync already recorded it as failed.

      if (pending.length > 1) await sleep(IMPORT_DELAY_MS); // same spacing rationale as runImport
    }

    await browser.storage.local.set({ [PENDING_BOOKMARKS_KEY]: stillPending });
  } finally {
    isFlushingPendingBookmarks = false;
  }
}

// Used by onChanged (title edits) and onMoved (category, from a folder
// move). A 404 means the Worker never had this url in the first place
// (e.g. it failed to sync originally) — not an error worth logging, since
// there's nothing to patch either way.
async function patchBookmark(url, fields) {
  try {
    await apiPatch(`/bookmarks?url=${encodeURIComponent(url)}`, fields);
  } catch (err) {
    if (err.status !== 404) {
      console.error(`[BookmarkSync] Patch failed for ${url}: ${err.status ?? err.message}`);
    }
  }
}

// Used by onRemoved. Same 404-is-fine reasoning as patchBookmark above.
async function deleteBookmark(url) {
  try {
    await apiDelete(`/bookmarks?url=${encodeURIComponent(url)}`);
  } catch (err) {
    if (err.status !== 404) {
      console.error(`[BookmarkSync] Delete failed for ${url}: ${err.status ?? err.message}`);
    }
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
