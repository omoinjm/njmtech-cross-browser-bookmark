const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

/**
 * Cross-browser smoke tests for the extension.
 *
 * Chrome/Edge: driven for real here via a loaded unpacked Chromium
 * extension (Edge shares Chromium's engine and this project's manifest key
 * for it — `background.service_worker` — so a passing Chromium run is
 * standing in for Edge too, not just Chrome).
 *
 * Firefox: NOT driven live here — real Firefox WebExtension automation is
 * far less standardized than Chromium's (no simple "load this unpacked
 * extension" launch flag), so Firefox compatibility is instead covered by
 * `npm run lint:firefox` (Mozilla's own web-ext linter against
 * manifest.json), run as a separate CI step alongside this file.
 */

// The popup/library pages fetch from WORKER_API_URL on load or on user
// action — mocked here so this smoke test never depends on (or accidentally
// hits) a real backend, and never needs a real API token.
async function mockWorkerApi(page) {
  await page.route('https://example.invalid/api/v1/**', (route) => {
    const url = route.request().url();
    const body = url.includes('/search')
      ? { results: [] }
      : url.includes('/categories/suggest-reorganization')
        ? { suggestions: [] }
        : url.includes('/categories')
          ? { categories: [] }
          : url.includes('/tags')
            ? { tags: [] }
            : url.includes('/bookmarks')
              ? { bookmarks: [] }
              : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

function collectErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test('popup loads cleanly and all three tabs switch correctly', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = collectErrors(page);
  await mockWorkerApi(page);

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForSelector('#tab-bar');

  await expect(page.locator('#tab-import')).toBeVisible();
  await expect(page.locator('#tab-suggest')).toBeHidden();
  await expect(page.locator('#tab-search')).toBeHidden();

  await page.click('.tab-btn[data-tab="suggest"]');
  await expect(page.locator('#tab-suggest')).toBeVisible();
  await expect(page.locator('#tab-import')).toBeHidden();

  await page.click('.tab-btn[data-tab="search"]');
  await expect(page.locator('#tab-search')).toBeVisible();
  await expect(page.locator('#tab-suggest')).toBeHidden();

  await page.click('.tab-btn[data-tab="import"]');
  await expect(page.locator('#tab-import')).toBeVisible();
  await expect(page.locator('#tab-search')).toBeHidden();

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('reorg suggestions mix category renames and bookmark moves, and apply sends both back', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const errors = collectErrors(page);

  const suggestions = [
    { type: 'category', from: 'Design', to: 'Design & Icons', reason: 'Near-duplicate of an existing category' },
    { type: 'bookmark', bookmarkId: 42, url: 'https://example.com/recipe', title: 'Pasta Recipe', from: 'Dev Tools', to: 'Cooking', reason: 'Not a dev tool' },
  ];

  let reorganizeBody = null;
  await page.route('https://example.invalid/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/categories/suggest-reorganization')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suggestions }) });
    }
    if (url.includes('/categories/reorganize')) {
      reorganizeBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ applied: 2 }) });
    }
    const body = url.includes('/categories') ? { categories: [] } : url.includes('/tags') ? { tags: [] } : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.click('.tab-btn[data-tab="suggest"]');
  await page.click('#suggest-reorg-btn');

  await expect(page.locator('.reorg-item')).toHaveCount(2);
  // Only the bookmark-type suggestion gets a title line distinguishing it
  // from a whole-category rename.
  await expect(page.locator('.reorg-bookmark-title')).toHaveText('Pasta Recipe');
  await expect(page.locator('.reorg-item').nth(0).locator('.reorg-paths')).toHaveText('Design▸Design & Icons');
  await expect(page.locator('.reorg-item').nth(1).locator('.reorg-paths')).toHaveText('Dev Tools▸Cooking');

  await page.click('#reorg-apply-btn');
  await expect(page.locator('#reorg-status')).toHaveText('Applied 2 change(s).');

  expect(reorganizeBody.items).toEqual(suggestions);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('library page loads cleanly', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = collectErrors(page);
  await mockWorkerApi(page);

  await page.goto(`chrome-extension://${extensionId}/library.html`);
  // The mocked backend returns zero bookmarks, so #bookmark-list itself
  // stays a zero-height empty <ul> (never "visible" to Playwright, even on
  // a fully successful load) — #status-line starts empty in the raw HTML
  // and is only ever set once loadBookmarks() completes its fetch, so
  // waiting for its text is a real signal the load-and-render cycle ran
  // end to end, not just that the page opened.
  await expect(page.locator('#status-line')).toHaveText('All bookmarks');

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('search mode toggle switches search requests between keyword and semantic', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = collectErrors(page);

  const requestedModes = [];
  await page.route('https://example.invalid/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname.endsWith('/categories')) return json(200, { categories: [] });
    if (url.pathname.endsWith('/tags')) return json(200, { tags: [] });
    if (url.pathname.endsWith('/search')) {
      requestedModes.push(url.searchParams.get('mode'));
      return json(200, { query: url.searchParams.get('q'), results: [] });
    }
    if (url.pathname.endsWith('/bookmarks')) return json(200, { bookmarks: [] });
    return json(200, {});
  });

  await page.goto(`chrome-extension://${extensionId}/library.html`);
  await page.fill('#search-input', 'docker');
  await expect.poll(() => requestedModes.length).toBeGreaterThan(0);
  expect(requestedModes.at(-1)).toBe('keyword'); // default, unchecked

  // The checkbox itself is visually hidden (see .ai-toggle-input in
  // theme.css) — a real user clicks the visible pill, which the <label>
  // wrapping it forwards to the checkbox natively.
  const toggle = page.locator('label:has(#semantic-search-toggle) .ai-toggle-track');
  await toggle.click();
  await expect.poll(() => requestedModes.at(-1)).toBe('semantic');

  await toggle.click(); // back off
  await expect.poll(() => requestedModes.at(-1)).toBe('keyword');

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('library page can add, edit, and delete a bookmark', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = collectErrors(page);
  page.on('dialog', (dialog) => dialog.accept()); // deleteCard()'s confirm()

  // Stateful (unlike mockWorkerApi above) so GET /bookmarks reflects
  // whatever the add/edit/delete calls just did — a plain fixed mock can't
  // exercise a round trip through the Library's own UI.
  let bookmark = null;

  await page.route('https://example.invalid/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname.endsWith('/categories')) return json(200, { categories: [] });
    if (url.pathname.endsWith('/tags')) return json(200, { tags: [] });

    if (url.pathname.endsWith('/bookmarks') && method === 'GET') {
      return json(200, { bookmarks: bookmark ? [bookmark] : [] });
    }
    if (url.pathname.endsWith('/bookmarks') && method === 'POST') {
      const body = request.postDataJSON();
      bookmark = { id: 1, url: body.url, title: body.title || body.url, category: body.category || null, tags: [], status: 'pending' };
      return json(202, { id: 1, status: 'pending' });
    }
    if (url.pathname.endsWith('/bookmarks') && method === 'PATCH') {
      if (!bookmark) return json(404, { error: 'Not found' });
      const body = request.postDataJSON();
      if ('title' in body) bookmark.title = body.title;
      if ('category' in body) bookmark.category = body.category;
      if ('tags' in body) bookmark.tags = body.tags;
      return json(200, { ok: true });
    }
    if (url.pathname.endsWith('/bookmarks') && method === 'DELETE') {
      bookmark = null;
      return json(200, { ok: true });
    }

    return json(200, {});
  });

  await page.goto(`chrome-extension://${extensionId}/library.html`);
  await expect(page.locator('#empty-state')).toBeVisible();

  await page.click('#add-bookmark-btn');
  await page.fill('#add-url', 'https://example.com/test-page');
  await page.fill('#add-title', 'Test Page');
  await page.click('#add-submit-btn');

  await expect(page.locator('.bookmark-card .title')).toHaveText('Test Page');
  await expect(page.locator('#add-bookmark-form')).toBeHidden();

  await page.click('.bookmark-card .btn-ghost:not(.btn-danger)'); // Edit
  await expect(page.locator('.bookmark-card')).toHaveClass(/editing/);
  await page.fill('.edit-form .form-row:nth-child(1) input', 'Renamed Title');
  await page.click('.edit-form button[type="submit"]');
  await expect(page.locator('.bookmark-card .title')).toHaveText('Renamed Title');

  await page.click('.bookmark-card .btn-danger'); // Delete
  await expect(page.locator('#empty-state')).toBeVisible();

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('adding via the Library creates a native bookmark, and deleting removes it', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = collectErrors(page);
  page.on('dialog', (dialog) => dialog.accept());

  let bookmark = null;

  await page.route('https://example.invalid/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname.endsWith('/categories')) return json(200, { categories: [] });
    if (url.pathname.endsWith('/tags')) return json(200, { tags: [] });
    if (url.pathname.endsWith('/bookmarks') && method === 'GET') return json(200, { bookmarks: bookmark ? [bookmark] : [] });
    if (url.pathname.endsWith('/bookmarks') && method === 'POST') {
      const body = request.postDataJSON();
      bookmark = { id: 1, url: body.url, title: body.title || body.url, category: body.category || null, tags: [], status: 'pending' };
      return json(202, { id: 1, status: 'pending' });
    }
    if (url.pathname.endsWith('/bookmarks') && method === 'DELETE') {
      bookmark = null;
      return json(200, { ok: true });
    }

    return json(200, {});
  });

  await page.goto(`chrome-extension://${extensionId}/library.html`);

  // Real chrome.bookmarks state, checked from the same extension context
  // library.js runs in — not a mock, this is background.js's writeNativeCreate/
  // writeNativeDelete actually running against the (real, empty) test profile.
  const testUrl = 'https://example.com/native-write-back-test';
  const searchTestUrl = () => page.evaluate((u) => browser.bookmarks.search({ url: u }), testUrl);

  await page.click('#add-bookmark-btn');
  await page.fill('#add-url', testUrl);
  await page.fill('#add-title', 'Native Write-back Test');
  await page.click('#add-submit-btn');
  await expect(page.locator('.bookmark-card .title')).toHaveText('Native Write-back Test');

  // writeNativeCreate runs off a fire-and-forget runtime message, so this
  // may not have landed the instant the Library UI updates — poll for it.
  await expect.poll(searchTestUrl, { timeout: 5000 }).toHaveLength(1);

  await page.click('.bookmark-card .btn-danger');
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect.poll(searchTestUrl, { timeout: 5000 }).toHaveLength(0);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('export downloads a Netscape bookmarks.html reflecting real categories', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = collectErrors(page);

  const bookmarks = [
    { id: 1, url: 'https://example.com/a', title: 'A', category: 'Dev Tools/AI', tags: [], status: 'processed', created_at: '2024-01-01T00:00:00Z' },
    { id: 2, url: 'https://example.com/b', title: 'B', category: null, tags: [], status: 'processed', created_at: '2024-01-02T00:00:00Z' },
  ];

  await page.route('https://example.invalid/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname.endsWith('/categories')) return json(200, { categories: [] });
    if (url.pathname.endsWith('/tags')) return json(200, { tags: [] });
    if (url.pathname.endsWith('/bookmarks')) {
      const offset = Number(url.searchParams.get('offset') || 0);
      return json(200, { bookmarks: offset === 0 ? bookmarks : [] });
    }
    return json(200, {});
  });

  await page.goto(`chrome-extension://${extensionId}/library.html`);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const content = fs.readFileSync(await download.path(), 'utf8');

  expect(content).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  expect(content).toContain('<H3>Dev Tools</H3>');
  expect(content).toContain('<H3>AI</H3>');
  expect(content).toContain('<A HREF="https://example.com/a" ADD_DATE="1704067200">A</A>');
  expect(content).toContain('<A HREF="https://example.com/b" ADD_DATE="1704153600">B</A>');

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('importing a bookmarks.html file posts each bookmark with its real folder path as category', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const errors = collectErrors(page);
  page.on('dialog', (dialog) => dialog.accept());

  const posted = [];
  // context.route(), not page.route(): the actual import work (syncBookmark,
  // fetchExistingCategoriesByUrl) runs in background.js's service worker
  // context via the "import-entries" runtime message, not in this page — a
  // page-scoped route wouldn't see those fetches at all.
  await context.route('https://example.invalid/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname.endsWith('/categories')) return json(200, { categories: [] });
    if (url.pathname.endsWith('/tags')) return json(200, { tags: [] });
    if (url.pathname.endsWith('/url-categories')) return json(200, { categories: {} });
    if (url.pathname.endsWith('/bookmarks') && method === 'GET') return json(200, { bookmarks: [] });
    if (url.pathname.endsWith('/bookmarks') && method === 'POST') {
      posted.push(request.postDataJSON());
      return json(202, { id: posted.length, status: 'pending' });
    }
    return json(200, {});
  });

  await page.goto(`chrome-extension://${extensionId}/library.html`);

  // Deliberately unclosed <DT>s, matching a real Netscape export — the
  // nested <DL> under "Dev Tools" ends up parsed as a CHILD of that <DT>
  // (not a sibling), which is exactly the quirk parseNetscapeBookmarksHtml's
  // `dt > h3` / `dt > dl` selectors are written for.
  const bookmarksHtml = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<DL><p>',
    '    <DT><H3>Dev Tools</H3>',
    '    <DL><p>',
    '        <DT><A HREF="https://example.com/imported">Imported Page</A>',
    '    </DL><p>',
    '    <DT><A HREF="https://example.com/top-level">Top Level Page</A>',
    '</DL><p>',
  ].join('\n');

  await page
    .locator('#import-file-input')
    .setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(bookmarksHtml) });

  await expect.poll(() => posted.length, { timeout: 5000 }).toBe(2);

  const byUrl = Object.fromEntries(posted.map((b) => [b.url, b]));
  expect(byUrl['https://example.com/imported'].category).toBe('Dev Tools');
  expect(byUrl['https://example.com/top-level'].category).toBeUndefined(); // top-level: no category sent at all

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('background service worker starts cleanly with commands/omnibox/contextMenus wired up', async ({
  context,
  extensionId,
}) => {
  // Phase 6 added top-level browser.omnibox/.commands/.contextMenus calls to
  // background.js — a thrown exception there wouldn't undo listener
  // registrations made earlier in the same script (JS executes statements
  // to completion before the next one starts), but a background script that
  // throws on load is still worth a real check, not an assumption.
  const sw = context.serviceWorkers().find((worker) => new URL(worker.url()).host === extensionId);
  expect(sw).toBeTruthy();

  const errors = [];
  sw.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const apisPresent = await sw.evaluate(() => ({
    omnibox: typeof browser.omnibox?.onInputChanged?.addListener === 'function',
    commands: typeof browser.commands?.onCommand?.addListener === 'function',
    contextMenus: typeof browser.contextMenus?.create === 'function',
  }));

  expect(apisPresent).toEqual({ omnibox: true, commands: true, contextMenus: true });
  expect(errors).toEqual([]);
});

test('manifest keeps both Chrome/Edge and Firefox background entry points', async () => {
  // A pure file check, not browser-driven — deliberately doesn't destructure
  // `context` above, so Playwright never launches a browser for this one.
  // Guards against an edit that accidentally drops one of the two
  // background keys this project's cross-browser support depends on.
  const manifestPath = path.resolve(__dirname, '../extension/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  expect(manifest.background.service_worker).toBeTruthy();
  expect(manifest.background.scripts).toContain('background.js');
  expect(manifest.browser_specific_settings?.gecko?.id).toBeTruthy();
});
