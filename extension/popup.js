const importBtn = document.getElementById('import-btn');
const libraryBtn = document.getElementById('library-btn');
const progressEl = document.getElementById('progress');
const activityListEl = document.getElementById('activity-list');
const emptyStateEl = document.getElementById('empty-state');
const suggestCategoryToggle = document.getElementById('suggest-category-toggle');

importBtn.addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'start-import' });
  // Optimistic disable — the real state (from storage) confirms this on the
  // next render, including if background.js decides not to start because an
  // import is already running.
  importBtn.disabled = true;
});

libraryBtn.addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('library.html') });
});

suggestCategoryToggle.addEventListener('change', async () => {
  const { settings } = await browser.storage.local.get('settings');
  await browser.storage.local.set({
    settings: { ...settings, suggestCategoryForUnfiled: suggestCategoryToggle.checked },
  });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.syncState) renderProgress(changes.syncState.newValue);
  if (changes.recentActivity) renderActivity(changes.recentActivity.newValue);
});

function renderProgress(syncState) {
  if (!syncState) {
    progressEl.textContent = '';
    importBtn.disabled = false;
    return;
  }

  if (syncState.importRunning) {
    progressEl.textContent = `Importing ${syncState.importCurrent} / ${syncState.importTotal}…`;
    importBtn.disabled = true;
  } else if (syncState.importTotal > 0) {
    progressEl.textContent = `Import complete — ${syncState.importTotal} bookmark(s) processed.`;
    importBtn.disabled = false;
  } else {
    progressEl.textContent = '';
    importBtn.disabled = false;
  }
}

function renderActivity(entries) {
  activityListEl.innerHTML = '';
  const list = entries || [];
  emptyStateEl.style.display = list.length === 0 ? '' : 'none';

  for (const entry of list) {
    const li = document.createElement('li');
    li.className = entry.status === 'failed' ? 'failed' : 'synced';
    li.title = entry.url;

    // textContent, not innerHTML — a bookmark title is untrusted (user- or
    // page-supplied), so it must never be parsed as markup.
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.category ? `${entry.title || entry.url} — ${entry.category}` : entry.title || entry.url;
    li.appendChild(label);

    activityListEl.appendChild(li);
  }
}

// --- Tabs ---
//
// Import / Suggest / Search. Purely a display toggle — each tab's own logic
// below runs regardless of which one is visible (e.g. an import can keep
// progressing while the Search tab is open), so switching tabs never cancels
// in-flight work.

const tabBtns = document.querySelectorAll('.tab-btn');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  tabBtns.forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `tab-${name}`;
  });
}

// --- AI-suggested category reorganization ---
//
// Analyzes the whole current category list AND every categorized bookmark's
// title, proposing two kinds of fixes: renaming/merging a whole poorly-named
// category, or moving one individually misfiled bookmark into a different
// existing category (see category-reorganizer.ts). Suggest-only: nothing
// changes until the user reviews and clicks Apply, which sends back only the
// checked entries. Ported from the Library page, which no longer has its own
// copy of this feature.

const suggestReorgBtn = document.getElementById('suggest-reorg-btn');
const reorgStatusEl = document.getElementById('reorg-status');
const reorgListEl = document.getElementById('reorg-list');
const reorgActionsEl = document.getElementById('reorg-actions');
const reorgApplyBtn = document.getElementById('reorg-apply-btn');
const reorgCancelBtn = document.getElementById('reorg-cancel-btn');

let currentReorgSuggestions = [];

suggestReorgBtn.addEventListener('click', startReorgSuggestion);
reorgCancelBtn.addEventListener('click', closeReorgPanel);
reorgApplyBtn.addEventListener('click', applySelectedReorg);

async function startReorgSuggestion() {
  reorgListEl.innerHTML = '';
  reorgActionsEl.hidden = true;
  reorgStatusEl.textContent = 'Analyzing your category structure…';
  suggestReorgBtn.disabled = true;

  try {
    const data = await apiPost('/categories/suggest-reorganization', {});
    currentReorgSuggestions = data.suggestions || [];
    renderReorgSuggestions();
  } catch (err) {
    console.error('[Popup] Failed to get reorganization suggestions:', err);
    reorgStatusEl.textContent = 'Failed to get suggestions — is the Worker reachable?';
  } finally {
    suggestReorgBtn.disabled = false;
  }
}

function renderReorgSuggestions() {
  reorgListEl.innerHTML = '';

  if (currentReorgSuggestions.length === 0) {
    reorgStatusEl.textContent = 'No changes suggested — your categories already look reasonably organized.';
    reorgActionsEl.hidden = true;
    return;
  }

  reorgStatusEl.textContent = `${currentReorgSuggestions.length} suggested change(s). Uncheck any you don't want, then apply.`;
  reorgActionsEl.hidden = false;

  currentReorgSuggestions.forEach((suggestion, index) => {
    const li = document.createElement('li');
    li.className = 'reorg-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = String(index);

    const body = document.createElement('div');
    body.className = 'reorg-item-body';

    if (suggestion.type === 'bookmark') {
      // Distinguishes an individual misfiled-bookmark move from a
      // whole-category rename — without this, "Dev Tools/AI ▸ Dev Tools"
      // reads identically for both, but only one of them affects every
      // other bookmark in that category.
      const title = document.createElement('div');
      title.className = 'reorg-bookmark-title';
      title.textContent = suggestion.title || suggestion.url;
      body.appendChild(title);
    }

    const paths = document.createElement('div');
    paths.className = 'reorg-paths';
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = suggestion.from;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '▸';
    const to = document.createElement('span');
    to.className = 'to';
    to.textContent = suggestion.to;
    paths.append(from, arrow, to);

    body.appendChild(paths);

    if (suggestion.reason) {
      const reason = document.createElement('div');
      reason.className = 'reorg-reason';
      reason.textContent = suggestion.reason;
      body.appendChild(reason);
    }

    li.append(checkbox, body);
    reorgListEl.appendChild(li);
  });
}

async function applySelectedReorg() {
  const selected = [...reorgListEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (checkbox) => currentReorgSuggestions[Number(checkbox.dataset.index)]
  );

  if (selected.length === 0) {
    reorgStatusEl.textContent = 'Select at least one suggestion to apply.';
    return;
  }

  reorgApplyBtn.disabled = true;
  reorgStatusEl.textContent = 'Applying…';

  try {
    // Sent back verbatim — the server only reads type/from/to/bookmarkId
    // from each entry and ignores the rest (title/url/reason), and
    // re-validates everything against current state anyway (see
    // categories.ts's /reorganize).
    const data = await apiPost('/categories/reorganize', { items: selected });
    reorgStatusEl.textContent = `Applied ${data.applied} change(s).`;
    reorgListEl.innerHTML = '';
    reorgActionsEl.hidden = true;
    currentReorgSuggestions = [];
  } catch (err) {
    console.error('[Popup] Failed to apply reorganization:', err);
    reorgStatusEl.textContent = `Failed to apply: ${err.message}`;
  } finally {
    reorgApplyBtn.disabled = false;
  }
}

function closeReorgPanel() {
  reorgListEl.innerHTML = '';
  reorgActionsEl.hidden = true;
  reorgStatusEl.textContent = '';
  currentReorgSuggestions = [];
}

// --- Search ---
//
// A compact version of the Library page's search: same /api/v1/search
// endpoint and highlighted-snippet rendering, trimmed down to fit the popup
// (no category/tag sidebars — a result's category label instead deep-links
// into the full Library page, same as the Ctrl+D suggestion notification does).

const searchInput = document.getElementById('search-input');
const semanticSearchToggle = document.getElementById('semantic-search-toggle');
const searchStatusEl = document.getElementById('search-status');
const searchResultsEl = document.getElementById('search-results');

searchInput.addEventListener(
  'input',
  debounce(() => runSearch(searchInput.value.trim()), 300)
);

// Re-runs immediately (no debounce) on toggle — this isn't the user typing,
// it's a deliberate mode switch, and the existing query is already known.
semanticSearchToggle.addEventListener('change', () => runSearch(searchInput.value.trim()));

async function runSearch(query) {
  if (!query) {
    searchResultsEl.innerHTML = '';
    searchStatusEl.textContent = '';
    return;
  }

  try {
    const mode = semanticSearchToggle.checked ? 'semantic' : 'keyword';
    const data = await apiGet(`/search?q=${encodeURIComponent(query)}&mode=${mode}`);
    const results = data.results || [];
    searchStatusEl.textContent = `${results.length} result(s) for "${query}"`;
    // Surfaces what the AI query-expander added, rather than silently
    // widening the search behind the scenes — see search.ts. Semantic mode
    // never returns this (there's no keyword query to expand).
    if (data.expandedTerms?.length) {
      searchStatusEl.textContent += ` — AI also searched: ${data.expandedTerms.join(', ')}`;
    }
    renderSearchResults(results);
  } catch (err) {
    console.error('[Popup] Search failed:', err);
    searchStatusEl.textContent = 'Search failed — is the Worker reachable?';
  }
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';

  for (const bookmark of results) {
    searchResultsEl.appendChild(renderSearchResultCard(bookmark));
  }
}

function renderSearchResultCard(bookmark) {
  const li = document.createElement('li');
  li.className = 'search-result';

  const link = document.createElement('a');
  link.className = 'title';
  link.href = bookmark.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = bookmark.title || bookmark.url;
  li.appendChild(link);

  const urlEl = document.createElement('span');
  urlEl.className = 'url';
  urlEl.textContent = bookmark.url;
  li.appendChild(urlEl);

  if (bookmark.category) {
    const categoryEl = document.createElement('button');
    categoryEl.type = 'button';
    categoryEl.className = 'category-label';
    categoryEl.textContent = bookmark.category;
    categoryEl.addEventListener('click', () => {
      browser.tabs.create({
        url: browser.runtime.getURL(`library.html?category=${encodeURIComponent(bookmark.category)}`),
      });
    });
    li.appendChild(categoryEl);
  }

  if (bookmark.snippet) {
    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    appendHighlightedSnippet(snippet, bookmark.snippet);
    li.appendChild(snippet);
  }

  return li;
}

// The backend marks FTS matches with U+0001/U+0002 (see search.ts), not
// literal HTML tags — the snippet's source text is a scraped page's own
// visible text, which is untrusted. Splitting on those markers and building
// <mark> nodes via textContent (never innerHTML) means a bookmarked page
// whose text happens to look like markup can't execute here.
const SNIPPET_SPLIT_PATTERN = /[]/;

function appendHighlightedSnippet(container, snippet) {
  let highlighting = false;

  for (const part of snippet.split(SNIPPET_SPLIT_PATTERN)) {
    if (part) {
      const node = highlighting ? document.createElement('mark') : document.createTextNode('');
      node.textContent = part;
      container.appendChild(node);
    }
    highlighting = !highlighting;
  }
}

function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// Authentication is a per-account session token (obtained via the Account
// tab logging in), not a static config-file secret — read fresh on every
// request so a logout/re-login takes effect immediately.
async function getSessionToken() {
  const { sessionToken } = await browser.storage.local.get('sessionToken');
  return sessionToken || null;
}

async function apiGet(path) {
  const sessionToken = await getSessionToken();
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!response.ok) {
    throw new Error(`Worker responded ${response.status}`);
  }
  return response.json();
}

async function apiPost(path, body) {
  const sessionToken = await getSessionToken();
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || `Worker responded ${response.status}`);
  }
  return response.json();
}

// --- Account ---
//
// Email + an auto-generated password (see auth.ts server-side) — no
// third-party identity provider. Registering never returns a password
// directly; it's emailed. The resulting session token is stored in
// storage.local and read by every apiGet/apiPost/etc. helper above (and by
// background.js's and library.js's own copies of the same pattern).

const accountLoggedOutEl = document.getElementById('account-logged-out');
const accountLoggedInEl = document.getElementById('account-logged-in');
const accountEmailEl = document.getElementById('account-email');

const loginForm = document.getElementById('login-form');
const loginEmailInput = document.getElementById('login-email');
const loginPasswordInput = document.getElementById('login-password');
const loginStatusEl = document.getElementById('login-status');

const registerForm = document.getElementById('register-form');
const registerEmailInput = document.getElementById('register-email');
const registerStatusEl = document.getElementById('register-status');

const forgotPasswordBtn = document.getElementById('forgot-password-btn');
const forgotPasswordStatusEl = document.getElementById('forgot-password-status');

const logoutBtn = document.getElementById('logout-btn');

// Import/Suggest/Search all call the authenticated API, so there's nothing
// for a logged-out visitor to do there — hide those tabs until a session
// exists, rather than showing them and letting every request 401.
const AUTH_GATED_TABS = ['import', 'suggest', 'search'];

// Only forces navigation on the logged-out side (off a tab that just got
// hidden). On login it deliberately leaves the user on the Account tab —
// forcing them over to Import would yank away the "Logged in as …"
// confirmation they just triggered. The one-time landing-on-Import for an
// already-valid session is handled separately, in init().
function setTabsAuthGate(loggedIn) {
  tabBtns.forEach((btn) => {
    if (AUTH_GATED_TABS.includes(btn.dataset.tab)) btn.hidden = !loggedIn;
  });

  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (!loggedIn && activeTab !== 'account') {
    switchTab('account');
  }
}

async function refreshAccountView() {
  const sessionToken = await getSessionToken();
  if (!sessionToken) {
    accountLoggedOutEl.hidden = false;
    accountLoggedInEl.hidden = true;
    setTabsAuthGate(false);
    return;
  }

  try {
    const data = await apiGet('/auth/me');
    accountEmailEl.textContent = data.user.email;
    accountLoggedOutEl.hidden = true;
    accountLoggedInEl.hidden = false;
    setTabsAuthGate(true);
  } catch (err) {
    // Session invalid/expired server-side — fall back to logged-out rather
    // than keep showing a stale "logged in" view for a token that no
    // longer works.
    console.error('[Popup] Failed to load account info:', err);
    await browser.storage.local.remove('sessionToken');
    accountLoggedOutEl.hidden = false;
    accountLoggedInEl.hidden = true;
    setTabsAuthGate(false);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginStatusEl.textContent = 'Logging in…';

  try {
    const data = await apiPost('/auth/login', {
      email: loginEmailInput.value.trim(),
      password: loginPasswordInput.value,
    });
    await browser.storage.local.set({ sessionToken: data.sessionToken });
    loginForm.reset();
    loginStatusEl.textContent = '';
    await refreshAccountView();
  } catch (err) {
    console.error('[Popup] Login failed:', err);
    loginStatusEl.textContent = `Login failed: ${err.message}`;
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  registerStatusEl.textContent = 'Sending…';

  try {
    const data = await apiPost('/auth/register', { email: registerEmailInput.value.trim() });
    registerForm.reset();
    registerStatusEl.textContent = data.message || 'Check your email for your password';
  } catch (err) {
    console.error('[Popup] Registration failed:', err);
    registerStatusEl.textContent = `Failed: ${err.message}`;
  }
});

forgotPasswordBtn.addEventListener('click', async () => {
  const email = loginEmailInput.value.trim();
  if (!email) {
    forgotPasswordStatusEl.textContent = 'Enter your email above first.';
    return;
  }

  forgotPasswordStatusEl.textContent = 'Sending…';
  try {
    const data = await apiPost('/auth/reset-password', { email });
    forgotPasswordStatusEl.textContent = data.message;
  } catch (err) {
    console.error('[Popup] Password reset failed:', err);
    forgotPasswordStatusEl.textContent = `Failed: ${err.message}`;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiPost('/auth/logout', {});
  } catch (err) {
    // The local session is cleared either way — a failed revoke call just
    // means the server-side token lingers until it expires on its own.
    console.error('[Popup] Logout request failed (clearing local session anyway):', err);
  }
  await browser.storage.local.remove('sessionToken');
  await refreshAccountView();
});

(async function init() {
  const { syncState, recentActivity, settings, sessionToken } = await browser.storage.local.get([
    'syncState',
    'recentActivity',
    'settings',
    'sessionToken',
  ]);
  renderProgress(syncState);
  renderActivity(recentActivity);
  suggestCategoryToggle.checked = Boolean(settings?.suggestCategoryForUnfiled);
  // Optimistic, based on the stored token alone — avoids a flash of hidden
  // tabs while refreshAccountView()'s /auth/me call confirms it; that call
  // corrects back to logged-out (and off of Import) if the token turned out
  // to be stale. Landing on Import (rather than Account) is a one-time
  // default for an already-logged-in visitor opening the popup fresh.
  setTabsAuthGate(Boolean(sessionToken));
  if (sessionToken) switchTab('import');
  await refreshAccountView();
})();
