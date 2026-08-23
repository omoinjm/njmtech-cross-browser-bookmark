// config.js — NOT committed (see .gitignore). Copy this file to config.js.
//
// No API token to fill in here anymore — authentication is a per-account
// session token obtained by registering/logging in from the popup's
// Account tab, stored in browser.storage.local. This file only ever needs
// to point at the Worker itself.
//
// Attached to `self` (not `const`) so it's reliably visible to whatever
// loads this — background.js via Chrome's importScripts() or Firefox's
// background "scripts" array, or library.html/popup.html via a plain
// <script> tag. Plain top-level `const` doesn't reliably cross the
// importScripts boundary the way an explicit global assignment does.
self.WORKER_API_URL = 'https://bookmarks.njmtech.co.za/api/v1';
