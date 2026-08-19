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
