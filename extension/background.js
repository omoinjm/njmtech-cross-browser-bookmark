// background.js — MV3 service worker
//
// Listens for native browser bookmark creation and forwards each new
// bookmark to the Cloudflare Worker, which handles scraping + AI tagging
// asynchronously. This script's job is just: detect, dedupe junk, POST.

const WORKER_API_URL = 'https://bookmarks.njmtech.co.za';

chrome.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  // Bookmark folders have no `url`; skip those. Also skip non-http(s)
  // schemes (chrome://, file://, javascript:) since the Worker can't
  // meaningfully scrape or search them.
  if (!bookmark.url || !/^https?:\/\//i.test(bookmark.url)) {
    return;
  }

  const title = await resolveBestTitle(bookmark);

  try {
    const response = await fetch(`${WORKER_API_URL}/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: bookmark.url, title }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`[BookmarkSync] Worker responded ${response.status}: ${errorBody}`);
      return;
    }

    const data = await response.json();
    console.log('[BookmarkSync] Synced bookmark:', data);
  } catch (err) {
    // Network failure, worker down, etc. The bookmark still exists locally —
    // it's just not synced to the backend this time.
    console.error('[BookmarkSync] Failed to reach Worker:', err);
  }
});

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
    const tabs = await chrome.tabs.query({ url: bookmark.url });
    return tabs[0]?.title?.trim() || null;
  } catch {
    return null;
  }
}
