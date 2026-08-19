// config.js — NOT committed (see .gitignore). Copy this file to config.js
// and fill in the same value you set with:
//
//   wrangler secret put API_TOKEN
//
// Attached to `self` (not `const`) so it's reliably visible to whatever
// loads this — background.js via Chrome's importScripts() or Firefox's
// background "scripts" array, or library.html/popup.html via a plain
// <script> tag. Plain top-level `const` doesn't reliably cross the
// importScripts boundary the way an explicit global assignment does.
self.API_TOKEN = 'REPLACE_WITH_YOUR_API_TOKEN';
self.WORKER_API_URL = 'https://bookmarks.njmtech.co.za/api/v1';
