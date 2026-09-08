// api-client.js — shared Worker API client for popup.js, library.js, and
// background.js. Loaded before all three (see manifest.json's
// background.scripts array and the <script> tags in popup.html/library.html)
// and relies on classic-script global scoping to make apiGet/apiPost/
// apiPatch/apiDelete/getSessionToken available to them with no import/export
// machinery — exactly how popup.js's own apiGet used to work before this
// file existed, just centralized instead of duplicated three times.
//
// Centralizing this is the forcing function for X-Profile-Id: every
// profile-scoped Worker endpoint (bookmarks/categories/tags/search — see
// require-profile.ts server-side) needs it, and this is the one place that
// can attach it to every request without touching three near-identical
// fetch implementations independently.

const FETCH_TIMEOUT_MS = 20000;

// Authentication is a per-account session token (obtained via the popup's
// Account tab logging in), not a static config-file secret — read fresh on
// every request so a logout/re-login takes effect immediately everywhere,
// including background.js's own captures.
async function getSessionToken() {
  const { sessionToken } = await browser.storage.local.get('sessionToken');
  return sessionToken || null;
}

// {id, name} of the profile every profile-scoped request should operate
// within. Stored as an object, not a bare id, so background.js's native
// folder resolution (getProfileRootFolderId) has the display name on hand
// without its own network round trip. Absent until resolveActiveProfile()
// below has run at least once — requests simply omit X-Profile-Id in that
// case, and the server's require-profile.ts middleware falls back to the
// caller's default ("Personal") profile, so nothing breaks either way.
async function getActiveProfile() {
  const { activeProfile } = await browser.storage.local.get('activeProfile');
  return activeProfile || null;
}

async function apiRequest(method, path, { body } = {}) {
  const [sessionToken, activeProfile] = await Promise.all([getSessionToken(), getActiveProfile()]);

  const headers = { Authorization: `Bearer ${sessionToken}` };
  if (activeProfile?.id) headers['X-Profile-Id'] = String(activeProfile.id);
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${WORKER_API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure, Worker unreachable, timeout (AbortError), etc. — no
    // response was ever received, so there's no HTTP status to report.
    // `.status` stays undefined so callers can tell this apart from a real
    // rejection (see background.js's attemptSync, which retries this case
    // but not a real 4xx/5xx).
    const wrapped = new Error(err.message || 'Network request failed');
    wrapped.status = undefined;
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const err = new Error(errorBody?.error || `Worker responded ${response.status}`);
    err.status = response.status;
    throw err;
  }

  if (response.status === 204) return null;
  return response.json();
}

async function apiGet(path) {
  return apiRequest('GET', path);
}

async function apiPost(path, body) {
  return apiRequest('POST', path, { body: body ?? {} });
}

async function apiPatch(path, body) {
  return apiRequest('PATCH', path, { body: body ?? {} });
}

async function apiDelete(path) {
  return apiRequest('DELETE', path);
}

// Fetches the caller's profiles (GET /profiles auto-provisions "Personal"
// server-side if none exist yet — see profiles.ts), keeps the stored
// activeProfile if it's still in that list, otherwise falls back to the
// first (oldest = implicit default) profile and persists it. Self-heals a
// stale activeProfile left over from a different account on the same
// device — a stale id simply won't be in the freshly-fetched list, so
// callers never need to special-case that themselves. Used by popup.js/
// library.js on init/login, and after creating or deleting a profile.
async function resolveActiveProfile() {
  const data = await apiGet('/profiles');
  const profiles = data.profiles || [];
  if (profiles.length === 0) return null; // shouldn't happen — GET /profiles always seeds one

  const { activeProfile } = await browser.storage.local.get('activeProfile');
  const stillValid = activeProfile && profiles.some((p) => p.id === activeProfile.id);
  const resolved = stillValid ? activeProfile : { id: profiles[0].id, name: profiles[0].name };

  await browser.storage.local.set({ activeProfile: resolved });
  return resolved;
}
