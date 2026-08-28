#!/usr/bin/env node
'use strict';

// Submits the packaged extension zip (web-ext-artifacts/azi-*.zip) to the
// Microsoft Edge Add-ons Update REST API (v1.1) and publishes the draft.
// Requires an existing Edge listing created once by hand in Partner Center
// — this API only updates an existing product, it can't create one. See:
// https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
//
// Required env vars: EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID

const fs = require('fs');
const path = require('path');

const API_ROOT = 'https://api.addons.microsoftedge.microsoft.com';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function findPackage() {
  const dir = path.join(process.cwd(), 'web-ext-artifacts');
  const zip = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => /^azi-.*\.zip$/.test(f));
  if (!zip) {
    console.error(`No azi-*.zip found in ${dir} — run "npm run package:firefox" first.`);
    process.exit(1);
  }
  return path.join(dir, zip);
}

// The Location header on a 202 response is documented to carry the bare
// operationID (not a full URL) — Microsoft's own sample script reads it the
// same way, then rebuilds the status-check URL from the endpoint template.
async function pollOperation(url, headers, label) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(url, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${label} status check failed: ${res.status} ${JSON.stringify(body)}`);
    }
    if (body.status === 'Succeeded') return body;
    if (body.status === 'Failed') {
      throw new Error(`${label} failed: ${JSON.stringify(body.errors || body)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} timed out after ${POLL_TIMEOUT_MS / 1000}s (last status: ${body.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const clientId = requireEnv('EDGE_CLIENT_ID');
  const apiKey = requireEnv('EDGE_API_KEY');
  const productId = requireEnv('EDGE_PRODUCT_ID');
  const headers = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };

  const zipPath = findPackage();
  const zipBuffer = fs.readFileSync(zipPath);

  console.log(`Uploading ${path.basename(zipPath)} to Edge product ${productId}...`);
  const uploadRes = await fetch(`${API_ROOT}/v1/products/${productId}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: zipBuffer,
  });
  if (uploadRes.status !== 202) {
    throw new Error(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  const uploadOperationId = uploadRes.headers.get('location');
  if (!uploadOperationId) throw new Error('Upload response missing Location header (operation id)');

  console.log('Upload accepted, waiting for it to finish processing...');
  await pollOperation(
    `${API_ROOT}/v1/products/${productId}/submissions/draft/package/operations/${uploadOperationId}`,
    headers,
    'Package upload',
  );

  console.log('Package processed. Publishing the draft...');
  const publishRes = await fetch(`${API_ROOT}/v1/products/${productId}/submissions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'Automated release via GitHub Actions' }),
  });
  if (publishRes.status !== 202) {
    throw new Error(`Publish failed: ${publishRes.status} ${await publishRes.text()}`);
  }
  const publishOperationId = publishRes.headers.get('location');
  if (!publishOperationId) throw new Error('Publish response missing Location header (operation id)');

  console.log('Publish accepted, waiting for it to clear the review queue check-in...');
  await pollOperation(
    `${API_ROOT}/v1/products/${productId}/submissions/operations/${publishOperationId}`,
    headers,
    'Publish',
  );

  console.log('Submitted to Microsoft Edge Add-ons for review.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
