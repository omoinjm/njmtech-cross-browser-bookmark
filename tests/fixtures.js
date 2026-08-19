const { test: base, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Loads the real unpacked extension into a persistent Chromium context —
 * Playwright's documented pattern for testing browser extensions, since
 * there's no `page`/`context` fixture that knows how to load one on its own.
 *
 * The extension is copied into a throwaway temp directory first, with a
 * stub config.js written in there (never in the real extension/ directory):
 * extension/config.js is gitignored, holds a real API token, and won't even
 * exist on a fresh checkout (e.g. in CI) — the fixture must never depend on
 * it being present, and must never risk overwriting a developer's real one.
 */
const test = base.extend({
  context: async ({}, use) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmark-ext-'));
    fs.cpSync(path.resolve(__dirname, '../extension'), tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config.js'),
      "self.API_TOKEN = 'test-token';\nself.WORKER_API_URL = 'https://example.invalid/api/v1';\n"
    );

    // headless: false + the explicit --headless=new CLI flag, not headless:
    // true — Chromium's old headless mode can't load extensions at all, and
    // Playwright's `headless: true` still maps to that old mode on some
    // versions. --load-extension only works under the new headless mode.
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [`--disable-extensions-except=${tmpDir}`, `--load-extension=${tmpDir}`, '--headless=new'],
    });

    await use(context);

    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    await use(new URL(sw.url()).host);
  },
});

module.exports = { test, expect: test.expect };
