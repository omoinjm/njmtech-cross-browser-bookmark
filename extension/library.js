const searchInput = document.getElementById('search-input');
const categoryNavEl = document.getElementById('category-nav');
const categoryTreeEl = document.getElementById('category-tree');
const tagNavEl = document.getElementById('tag-nav');
const bookmarkViewEl = document.getElementById('bookmark-view');
const bookmarkListEl = document.getElementById('bookmark-list');
const emptyStateEl = document.getElementById('empty-state');
const statusLineEl = document.getElementById('status-line');
const loadMoreBtn = document.getElementById('load-more-btn');
const importBannerEl = document.getElementById('import-banner');
const suggestReorgBtn = document.getElementById('suggest-reorg-btn');
const reorgPanelEl = document.getElementById('reorg-panel');
const reorgStatusEl = document.getElementById('reorg-status');
const reorgListEl = document.getElementById('reorg-list');
const reorgActionsEl = document.getElementById('reorg-actions');
const reorgApplyBtn = document.getElementById('reorg-apply-btn');
const reorgCancelBtn = document.getElementById('reorg-cancel-btn');

const PAGE_SIZE = 50;

// '' means "All". Category and tag filters are mutually exclusive (the
// backend only supports filtering by one dimension at a time), and search
// takes priority over both — the backend has no combined filter+search
// query, and FTS already covers tags/category, so searching within a
// filtered group just isn't a feature here.
let activeCategory = '';
let activeTag = '';
let offset = 0;
let loading = false;

// Last-fetched flat category list, kept around so toggling a tree node's
// expand/collapse state can re-render without another network round trip.
let lastCategoryCounts = [];

// Which tree node paths are expanded, by full path (e.g. "Dev Tools"). Purely
// in-memory for this page view — not persisted across reloads.
const expandedCategoryPaths = new Set();

searchInput.addEventListener('input', debounce(() => {
  offset = 0;
  loadBookmarks({ reset: true });
}, 300));

loadMoreBtn.addEventListener('click', () => loadBookmarks({ reset: false }));

categoryNavEl.querySelector('.nav-btn[data-category=""]').addEventListener('click', () => selectCategory(''));

suggestReorgBtn.addEventListener('click', startReorgSuggestion);
reorgCancelBtn.addEventListener('click', closeReorgPanel);
reorgApplyBtn.addEventListener('click', applySelectedReorg);

document.querySelectorAll('#sidebar h2.collapsible').forEach((heading) => {
  heading.addEventListener('click', () => {
    const expanded = heading.getAttribute('aria-expanded') === 'true';
    setSectionExpanded(heading, !expanded);
  });
});

function setSectionExpanded(heading, expanded) {
  heading.setAttribute('aria-expanded', String(expanded));
  document.getElementById(heading.dataset.target).classList.toggle('collapsed', !expanded);
}

function expandSectionFor(targetId) {
  const heading = document.querySelector(`#sidebar h2.collapsible[data-target="${targetId}"]`);
  if (heading) setSectionExpanded(heading, true);
}

// An import running in the popup (or another tab) writes progress to
// browser.storage.local — this page has no other way to know new
// categories/tags exist otherwise, since it only fetches them once on load.
// Refreshing on every single tick (every ~500ms per bookmark) would be
// chatty and jarring (rebuilds the tree, could reset scroll/expand state
// mid-interaction), so this refreshes at most every ~4s while an import is
// running, plus once immediately when it finishes.
let refreshTimer = null;

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.syncState) return;

  const wasRunning = Boolean(changes.syncState.oldValue?.importRunning);
  const state = changes.syncState.newValue;
  renderImportBanner(state);

  if (wasRunning && !state?.importRunning) {
    scheduleRefresh(0); // just finished — refresh right away
  } else if (state?.importRunning) {
    scheduleRefresh(4000);
  }
});

function scheduleRefresh(delayMs) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await Promise.all([loadCategories(), loadTags()]);
    await loadBookmarks({ reset: true });
  }, delayMs);
}

function renderImportBanner(state) {
  if (state?.importRunning) {
    importBannerEl.textContent = `Import in progress (${state.importCurrent} / ${state.importTotal}) — categories and tags refresh automatically as it runs.`;
    importBannerEl.hidden = false;
  } else {
    importBannerEl.hidden = true;
  }
}

init();

async function init() {
  const { syncState } = await browser.storage.local.get('syncState');
  renderImportBanner(syncState);
  await Promise.all([loadCategories(), loadTags()]);

  // Supports the "Suggested category" notification's deep link
  // (background.js's notifications.onClicked) — opens straight into that
  // category's filtered view instead of "All".
  const deepLinkCategory = new URLSearchParams(location.search).get('category');
  if (deepLinkCategory) {
    selectCategory(deepLinkCategory);
  } else {
    await loadBookmarks({ reset: true });
  }
}

async function loadCategories() {
  try {
    const data = await apiGet('/categories');
    lastCategoryCounts = data.categories || [];
    renderCategoryTree();
  } catch (err) {
    console.error('[Library] Failed to load categories:', err);
  }
}

// Builds a nested tree from flat "A/B/C" category strings. A node can be
// BOTH a real, clickable category (some bookmark's category is literally
// "Dev Tools") AND have children (deeper categories like "Dev Tools/Tools")
// — ownCount tracks the former, children the latter, independently.
function buildCategoryTree(categoryCounts) {
  const root = { name: '', fullPath: '', ownCount: 0, children: new Map() };

  for (const { category, count } of categoryCounts) {
    const segments = category.split('/').filter(Boolean);
    let node = root;
    let pathSoFar = '';

    for (const segment of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, fullPath: pathSoFar, ownCount: 0, children: new Map() });
      }
      node = node.children.get(segment);
    }

    node.ownCount = count;
  }

  return root;
}

function renderCategoryTree() {
  const root = buildCategoryTree(lastCategoryCounts);
  categoryTreeEl.innerHTML = '';
  appendTreeChildren(root, categoryTreeEl);
}

// Indentation is purely structural (each nested <ul class="tree-children">
// contributes its own CSS padding-left + border-left connector line), not a
// JS-computed depth value — no depth parameter needed here.
function appendTreeChildren(node, container) {
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    container.appendChild(renderTreeNode(child));
  }
}

function renderTreeNode(node) {
  const li = document.createElement('li');
  li.className = 'tree-item';

  const row = document.createElement('div');
  row.className = 'tree-row';

  const hasChildren = node.children.size > 0;
  const isExpanded = expandedCategoryPaths.has(node.fullPath);

  if (hasChildren) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.setAttribute('aria-expanded', String(isExpanded));
    toggle.textContent = '▸';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTreeNode(node.fullPath);
    });
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle-spacer';
    row.appendChild(spacer);
  }

  if (node.ownCount > 0) {
    // Label and count are flat siblings in the row, not nested inside one
    // another — see the CSS comment on .tree-label for why.
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tree-label';
    label.dataset.category = node.fullPath;
    label.textContent = node.name;
    if (activeCategory === node.fullPath) label.classList.add('active');
    label.addEventListener('click', () => selectCategory(node.fullPath));
    row.appendChild(label);

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(node.ownCount);
    row.appendChild(count);
  } else {
    // A pure grouping node — no bookmark has exactly this category, it only
    // exists as a path prefix for its children. Not clickable/filterable.
    const label = document.createElement('span');
    label.className = 'tree-label-group';
    label.textContent = node.name;
    row.appendChild(label);
  }

  li.appendChild(row);

  if (hasChildren) {
    const childrenEl = document.createElement('ul');
    childrenEl.className = 'tree-children';
    childrenEl.hidden = !isExpanded;
    appendTreeChildren(node, childrenEl);
    li.appendChild(childrenEl);
  }

  return li;
}

function toggleTreeNode(fullPath) {
  if (expandedCategoryPaths.has(fullPath)) {
    expandedCategoryPaths.delete(fullPath);
  } else {
    expandedCategoryPaths.add(fullPath);
  }
  renderCategoryTree();
}

async function loadTags() {
  try {
    const data = await apiGet('/tags');
    renderTagNav(data.tags || []);
  } catch (err) {
    console.error('[Library] Failed to load tags:', err);
  }
}

async function loadBookmarks({ reset }) {
  if (loading) return;
  loading = true;
  loadMoreBtn.disabled = true;

  try {
    const query = searchInput.value.trim();
    let bookmarks;
    let mayHaveMore = false;

    if (query) {
      const data = await apiGet(`/search?q=${encodeURIComponent(query)}`);
      bookmarks = data.results || [];
      statusLineEl.textContent = `${bookmarks.length} result(s) for "${query}"`;
    } else {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(reset ? 0 : offset) });
      if (activeCategory) {
        params.set('category', activeCategory);
      } else if (activeTag) {
        params.set('tag', activeTag);
      }
      const data = await apiGet(`/bookmarks?${params}`);
      bookmarks = data.bookmarks || [];
      mayHaveMore = bookmarks.length === PAGE_SIZE;
      offset = (reset ? 0 : offset) + bookmarks.length;
      statusLineEl.textContent = activeCategory
        ? `Category "${activeCategory}"`
        : activeTag
          ? `Tagged "${activeTag}"`
          : 'All bookmarks';
    }

    render(bookmarks, { append: !reset && !query });
    loadMoreBtn.hidden = !mayHaveMore;
  } catch (err) {
    console.error('[Library] Failed to load bookmarks:', err);
    statusLineEl.textContent = 'Failed to load bookmarks — is the Worker reachable?';
  } finally {
    loading = false;
    loadMoreBtn.disabled = false;
  }
}

function renderTagNav(tagCounts) {
  tagNavEl.innerHTML = '';

  for (const { tag, count } of tagCounts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-btn';
    btn.dataset.tag = tag;

    const label = document.createElement('span');
    label.textContent = tag;
    const countEl = document.createElement('span');
    countEl.className = 'count';
    countEl.textContent = String(count);

    btn.append(label, countEl);
    btn.addEventListener('click', () => selectTag(tag));
    tagNavEl.appendChild(btn);
  }
}

function selectCategory(category) {
  activeCategory = category;
  activeTag = '';
  offset = 0;
  searchInput.value = '';

  // Expand every ancestor folder so the active node is actually visible in
  // the tree, not hidden inside a collapsed parent.
  const segments = category.split('/').filter(Boolean);
  let path = '';
  for (const segment of segments.slice(0, -1)) {
    path = path ? `${path}/${segment}` : segment;
    expandedCategoryPaths.add(path);
  }

  categoryNavEl.querySelector('.nav-btn[data-category=""]').classList.toggle('active', category === '');
  renderCategoryTree();
  tagNavEl.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
  expandSectionFor('category-nav');

  loadBookmarks({ reset: true });
}

function selectTag(tag) {
  activeTag = tag;
  activeCategory = '';
  offset = 0;
  searchInput.value = '';

  tagNavEl.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tag === tag);
  });
  categoryNavEl.querySelector('.nav-btn[data-category=""]').classList.remove('active');
  renderCategoryTree();
  expandSectionFor('tag-nav');

  loadBookmarks({ reset: true });
}

function render(bookmarks, { append }) {
  if (!append) {
    bookmarkListEl.innerHTML = '';
  }

  emptyStateEl.style.display = !append && bookmarks.length === 0 ? '' : 'none';

  for (const bookmark of bookmarks) {
    bookmarkListEl.appendChild(renderCard(bookmark));
  }
}

function renderCard(bookmark) {
  const li = document.createElement('li');
  li.className = 'bookmark-card';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';

  const link = document.createElement('a');
  link.className = 'title';
  link.href = bookmark.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = bookmark.title || bookmark.url;
  titleRow.appendChild(link);

  const status = document.createElement('span');
  status.className = `status-badge ${bookmark.status}`;
  status.textContent = bookmark.status;
  titleRow.appendChild(status);

  li.appendChild(titleRow);

  const urlEl = document.createElement('span');
  urlEl.className = 'url';
  urlEl.textContent = bookmark.url;
  li.appendChild(urlEl);

  if (bookmark.category) {
    const categoryEl = document.createElement('button');
    categoryEl.type = 'button';
    categoryEl.className = 'category-label';
    categoryEl.textContent = bookmark.category;
    categoryEl.addEventListener('click', () => selectCategory(bookmark.category));
    li.appendChild(categoryEl);
  }

  if (bookmark.snippet) {
    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    appendHighlightedSnippet(snippet, bookmark.snippet);
    li.appendChild(snippet);
  }

  if (bookmark.tags?.length) {
    const pills = document.createElement('div');
    pills.className = 'tag-pills';
    for (const tag of bookmark.tags) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'tag-pill';
      pill.textContent = tag;
      pill.addEventListener('click', () => selectTag(tag));
      pills.appendChild(pill);
    }
    li.appendChild(pills);
  }

  return li;
}

// The backend marks FTS matches with U+0001/U+0002 (see search.ts), not
// literal HTML tags — the snippet's source text is a scraped page's own
// visible text, which is untrusted. Splitting on those markers and building
// <mark> nodes via textContent (never innerHTML) means a bookmarked page
// whose text happens to look like markup can't execute here.
const SNIPPET_SPLIT_PATTERN = /[\u0001\u0002]/;

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

async function apiGet(path) {
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Worker responded ${response.status}`);
  }
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || `Worker responded ${response.status}`);
  }
  return response.json();
}

// --- AI-suggested category reorganization ---
//
// "Suggest reorganization" analyzes the whole current category list at once
// (not per-bookmark) and proposes renames/merges for poorly-organized ones.
// Suggest-only: nothing changes until the user reviews and clicks Apply,
// which sends back only the checked entries.

let currentReorgSuggestions = [];

async function startReorgSuggestion() {
  bookmarkViewEl.hidden = true;
  reorgPanelEl.hidden = false;
  reorgListEl.innerHTML = '';
  reorgActionsEl.hidden = true;
  reorgStatusEl.textContent = 'Analyzing your category structure…';
  suggestReorgBtn.disabled = true;

  try {
    const data = await apiPost('/categories/suggest-reorganization', {});
    currentReorgSuggestions = data.suggestions || [];
    renderReorgSuggestions();
  } catch (err) {
    console.error('[Library] Failed to get reorganization suggestions:', err);
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
    const mapping = selected.map(({ from, to }) => ({ from, to }));
    const data = await apiPost('/categories/reorganize', { mapping });
    reorgStatusEl.textContent = `Applied ${data.applied} change(s). Refreshing…`;
    await Promise.all([loadCategories(), loadTags()]);
    await loadBookmarks({ reset: true });
    closeReorgPanel();
  } catch (err) {
    console.error('[Library] Failed to apply reorganization:', err);
    reorgStatusEl.textContent = `Failed to apply: ${err.message}`;
  } finally {
    reorgApplyBtn.disabled = false;
  }
}

function closeReorgPanel() {
  reorgPanelEl.hidden = true;
  bookmarkViewEl.hidden = false;
  reorgListEl.innerHTML = '';
  currentReorgSuggestions = [];
}

function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
