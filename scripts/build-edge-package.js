#!/usr/bin/env node
'use strict';

// Prepares a Chromium-flavored copy of extension/ into .edge-build/ for
// packaging (see package.json's "package:edge"). Edge Add-ons (and Chrome,
// which shares the same package validator) rejects two things Firefox
// requires/allows:
//
// - background.scripts alongside background.service_worker — Firefox needs
//   "scripts" (no real service worker support there historically); Chrome/
//   Edge only ever read "service_worker" and background.js itself detects
//   which context it's in via `typeof importScripts` (see background.js) —
//   so "scripts" is pure dead weight on Chromium and Edge's validator
//   errors on its presence under manifest_version 3.
// - manifest "description" over 132 characters — Firefox/AMO has no such
//   limit, so the canonical extension/manifest.json keeps the longer,
//   friendlier copy; only this Chromium build gets the trimmed one.
//
// browser_specific_settings (Firefox's gecko/gecko_android block) is also
// stripped — it's meaningless on Chromium, not because it was observed to
// fail validation.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'extension');
const BUILD_DIR = path.join(ROOT, '.edge-build');

const EDGE_DESCRIPTION =
  "The browser extension that remembers so you don't have to — AI-tagged, searchable bookmark sync.";

function main() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.cpSync(SRC_DIR, BUILD_DIR, { recursive: true });

  const manifestPath = path.join(BUILD_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  delete manifest.background.scripts;
  delete manifest.browser_specific_settings;
  manifest.description = EDGE_DESCRIPTION;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // Always overwrite with the checked-in template, never carry over whatever
  // extension/config.js happens to exist locally — a distributable package
  // must never be able to ship a developer's real local config (or stale
  // secrets from before config.js stopped needing one at all).
  fs.copyFileSync(path.join(BUILD_DIR, 'config.example.js'), path.join(BUILD_DIR, 'config.js'));

  console.log(`Prepared Chromium-flavored manifest at ${path.relative(ROOT, BUILD_DIR)}/`);
}

main();
