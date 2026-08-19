// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    // Extension tests launch their own persistent context with the unpacked
    // extension loaded (see tests/fixtures.js) — the built-in page/context
    // fixtures aren't used, so there's nothing browser-specific to set here.
    trace: 'retain-on-failure',
  },
});
