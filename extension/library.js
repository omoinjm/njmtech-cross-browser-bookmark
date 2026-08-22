const searchInput = document.getElementById('search-input');
const categoryNavEl = document.getElementById('category-nav');
const categoryTreeEl = document.getElementById('category-tree');
const tagNavEl = document.getElementById('tag-nav');
const bookmarkListEl = document.getElementById('bookmark-list');
const emptyStateEl = document.getElementById('empty-state');
const statusLineEl = document.getElementById('status-line');
const loadMoreBtn = document.getElementById('load-more-btn');
const importBannerEl = document.getElementById('import-banner');
const addBookmarkBtn = document.getElementById('add-bookmark-btn');
const addBookmarkForm = document.getElementById('add-bookmark-form');
const addUrlInput = document.getElementById('add-url');
const addTitleInput = document.getElementById('add-title');
const addCategoryInput = document.getElementById('add-category');
const addCancelBtn = document.getElementById('add-cancel-btn');
const addSubmitBtn = document.getElementById('add-submit-btn');
const addStatusEl = document.getElementById('add-status');
const categoryOptionsEl = document.getElementById('category-options');
const exportBtn = document.getElementById('export-btn');
const importFileBtn = document.getElementById('import-file-btn');
const importFileInput = document.getElementById('import-file-input');

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

addBookmarkBtn.addEventListener('click', () => {
  const wasHidden = addBookmarkForm.hidden;
  addBookmarkForm.hidden = !wasHidden;
  if (wasHidden) addUrlInput.focus();
});

addCancelBtn.addEventListener('click', closeAddForm);

function closeAddForm() {
  addBookmarkForm.hidden = true;
  addBookmarkForm.reset();
  addStatusEl.textContent = '';
}

addBookmarkForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = addUrlInput.value.trim();
  if (!url) return;

  addSubmitBtn.disabled = true;
  addStatusEl.textContent = 'Adding…';

  try {
    const body = { url };
    const title = addTitleInput.value.trim();
    const category = addCategoryInput.value.trim();
    if (title) body.title = title;
    if (category) body.category = category;

    // No `tags` field — the create endpoint doesn't accept one (tags come
    // from the async AI-tagging pipeline, which would overwrite a
    // manually-supplied value once it finishes anyway). Add tags via Edit
    // once the bookmark has finished processing.
    await apiPost('/bookmarks', body);
    closeAddForm();
    await refreshAfterMutation();

    // Mirrors this into the browser's native bookmarks too — see
    // background.js's writeNativeCreate. Fire-and-forget: the Worker POST
    // above already succeeded and is this bookmark's source of truth, so the
    // Library shouldn't wait on (or fail because of) the native mirror.
    notifyNativeWrite('native-create', { url, title: title || null, category: category || null });
  } catch (err) {
    console.error('[Library] Failed to add bookmark:', err);
    addStatusEl.textContent = `Failed to add: ${err.message}`;
  } finally {
    addSubmitBtn.disabled = false;
  }
});

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

  const params = new URLSearchParams(location.search);

  // Supports the "Suggested category" notification's deep link
  // (background.js's notifications.onClicked) — opens straight into that
  // category's filtered view instead of "All".
  const deepLinkCategory = params.get('category');
  // Supports the omnibox's "lib <query>" Enter-without-a-suggestion case
  // (background.js's omnibox.onInputEntered) — opens straight into that
  // search instead of "All".
  const deepLinkSearch = params.get('search');

  if (deepLinkCategory) {
    selectCategory(deepLinkCategory);
  } else if (deepLinkSearch) {
    searchInput.value = deepLinkSearch;
    await loadBookmarks({ reset: true });
  } else {
    await loadBookmarks({ reset: true });
  }
}

async function loadCategories() {
  try {
    const data = await apiGet('/categories');
    lastCategoryCounts = data.categories || [];
    renderCategoryTree();
    renderCategoryOptions();
  } catch (err) {
    console.error('[Library] Failed to load categories:', err);
  }
}

// Feeds the add/edit forms' category <input list="category-options"> so
// picking an existing category is a suggestion away, without forcing one —
// free text is still allowed, same as the real folder paths this mirrors.
function renderCategoryOptions() {
  categoryOptionsEl.innerHTML = '';
  for (const { category } of lastCategoryCounts) {
    const option = document.createElement('option');
    option.value = category;
    categoryOptionsEl.appendChild(option);
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
      // Surfaces what the AI query-expander added, rather than silently
      // widening the search behind the scenes — see search.ts.
      if (data.expandedTerms?.length) {
        statusLineEl.textContent += ` — AI also searched: ${data.expandedTerms.join(', ')}`;
      }
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

  li.appendChild(renderCardActions(li, bookmark));
  li.appendChild(renderEditForm(li, bookmark));

  return li;
}

function renderCardActions(li, bookmark) {
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn-ghost';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => li.classList.toggle('editing'));
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-ghost btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteCard(bookmark));
  actions.appendChild(deleteBtn);

  return actions;
}

async function deleteCard(bookmark) {
  const confirmed = confirm(
    `Delete "${bookmark.title || bookmark.url}"?\n\nThis removes it from the Library — and from your native bookmarks in this browser too, if it's bookmarked there.`
  );
  if (!confirmed) return;

  try {
    await apiDelete(`/bookmarks?url=${encodeURIComponent(bookmark.url)}`);
    await refreshAfterMutation();
    notifyNativeWrite('native-delete', { url: bookmark.url });
  } catch (err) {
    console.error('[Library] Failed to delete bookmark:', err);
    alert(`Failed to delete: ${err.message}`);
  }
}

// Built once per card (hidden until "Edit" toggles the .editing class on the
// <li>) rather than swapped in/out of the DOM — keeps the edit/cancel/save
// wiring a plain closure over `bookmark`/`li` instead of needing separate
// render-mode state tracked elsewhere.
function renderEditForm(li, bookmark) {
  const form = document.createElement('form');
  form.className = 'edit-form';

  const titleField = buildFormRow('Title', bookmark.title || '');
  const categoryField = buildFormRow('Category', bookmark.category || '', { list: 'category-options' });
  const tagsField = buildFormRow('Tags', (bookmark.tags || []).join(', '), { placeholder: 'comma, separated' });

  form.append(titleField.row, categoryField.row, tagsField.row);

  const statusEl = document.createElement('span');

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => li.classList.remove('editing'));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  actions.append(statusEl, cancelBtn, saveBtn);
  form.appendChild(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';

    try {
      const title = titleField.input.value.trim() || null;
      const category = categoryField.input.value.trim() || null;
      const tags = tagsField.input.value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      await apiPatch(`/bookmarks?url=${encodeURIComponent(bookmark.url)}`, { title, category, tags });

      li.classList.remove('editing');
      await refreshAfterMutation();
      // Tags have no native-bookmark equivalent — only title/category mirror.
      notifyNativeWrite('native-update', { url: bookmark.url, title, category });
    } catch (err) {
      console.error('[Library] Failed to save bookmark edit:', err);
      statusEl.textContent = `Failed: ${err.message}`;
      saveBtn.disabled = false;
    }
  });

  return form;
}

function buildFormRow(labelText, value, extraAttrs = {}) {
  const row = document.createElement('label');
  row.className = 'form-row';

  const span = document.createElement('span');
  span.textContent = labelText;
  row.appendChild(span);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.autocomplete = 'off';
  for (const [key, val] of Object.entries(extraAttrs)) {
    input.setAttribute(key, val);
  }
  row.appendChild(input);

  return { row, input };
}

// --- Export / Import file (Phase 5) ---
//
// Lets people get their data OUT (standard Netscape bookmarks.html, openable
// by literally every browser and bookmark tool) and IN from anywhere that
// format comes from — another browser profile, a different bookmark
// manager, an old backup — not just from this browser's live native tree
// (that's the existing popup "Import" button, which walks browser.bookmarks
// directly). A tool that only accepts data one way in isn't a real
// replacement for native bookmarks.

exportBtn.addEventListener('click', () => {
  exportBookmarksHtml().catch((err) => {
    console.error('[Library] Export failed:', err);
    alert(`Export failed: ${err.message}`);
  });
});

const EXPORT_PAGE_SIZE = 200; // matches the server's MAX_LIST_LIMIT

async function exportBookmarksHtml() {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';

  try {
    const bookmarks = await fetchAllBookmarksForExport();
    const html = buildExportHtml(bookmarks);
    const filename = `bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
    downloadFile(filename, html, 'text/html');
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export';
  }
}

async function fetchAllBookmarksForExport() {
  const all = [];
  let fetchOffset = 0;

  while (true) {
    const data = await apiGet(`/bookmarks?limit=${EXPORT_PAGE_SIZE}&offset=${fetchOffset}`);
    const rows = data.bookmarks || [];
    all.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
    fetchOffset += EXPORT_PAGE_SIZE;
  }

  return all;
}

// Builds a standard Netscape bookmarks.html document, grouping bookmarks by
// their slash-joined category into real nested <DL> folders — the inverse of
// how background.js's collectSyncableBookmarks derives a category from real
// folders on the way in.
function buildExportHtml(bookmarks) {
  const root = { children: new Map(), bookmarks: [] };

  for (const bookmark of bookmarks) {
    let node = root;
    for (const segment of (bookmark.category || '').split('/').filter(Boolean)) {
      if (!node.children.has(segment)) {
        node.children.set(segment, { children: new Map(), bookmarks: [] });
      }
      node = node.children.get(segment);
    }
    node.bookmarks.push(bookmark);
  }

  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    ...renderExportFolder(root),
    '',
  ].join('\n');
}

function renderExportFolder(node) {
  const lines = ['<DL><p>'];

  const childNames = [...node.children.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of childNames) {
    lines.push(`    <DT><H3>${escapeHtml(name)}</H3>`);
    lines.push(...renderExportFolder(node.children.get(name)).map((line) => `    ${line}`));
  }

  for (const bookmark of node.bookmarks) {
    const addDate = bookmark.created_at ? Math.floor(new Date(bookmark.created_at).getTime() / 1000) : '';
    const title = escapeHtml(bookmark.title || bookmark.url);
    lines.push(`    <DT><A HREF="${escapeHtml(bookmark.url)}" ADD_DATE="${addDate}">${title}</A>`);
  }

  lines.push('</DL><p>');
  return lines;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

importFileBtn.addEventListener('click', () => importFileInput.click());

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  importFileInput.value = ''; // lets the same file be re-selected later
  if (!file) return;

  try {
    const html = await file.text();
    const entries = parseNetscapeBookmarksHtml(html);

    if (entries.length === 0) {
      alert(`No bookmarks found in "${file.name}" — is it a Netscape-format bookmarks.html export?`);
      return;
    }
    if (!confirm(`Import ${entries.length} bookmark(s) from "${file.name}"?`)) {
      return;
    }

    // Handed off to background.js's importFromEntries, which shares the
    // same throttled/progress-tracked core as the native import — the
    // #import-banner above already listens for that progress and refreshes
    // this page when it's done.
    await browser.runtime.sendMessage({ type: 'import-entries', entries });
  } catch (err) {
    console.error('[Library] Failed to import file:', err);
    alert(`Failed to import file: ${err.message}`);
  }
});

// Parses a Netscape bookmarks.html export into a flat [{url, title,
// category}] list. The format's DTs are never explicitly closed in the
// source, so a folder's nested <DL> ends up parsed as a CHILD of the <DT>
// holding that folder's <H3> (an unclosed <dt> isn't implicitly closed by a
// following <dl> per the HTML5 spec — only by another <dt>/<dd>) — hence
// looking for `dt > h3` and `dt > dl` on the SAME <dt>, not siblings.
function parseNetscapeBookmarksHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rootDl = doc.querySelector('dl');
  const entries = [];
  if (rootDl) walkImportFolder(rootDl, [], entries);
  return entries;
}

function walkImportFolder(dl, pathSegments, out) {
  for (const dt of dl.querySelectorAll(':scope > dt')) {
    const h3 = dt.querySelector(':scope > h3');
    const link = dt.querySelector(':scope > a');

    if (h3) {
      const nestedDl = dt.querySelector(':scope > dl');
      if (nestedDl) {
        walkImportFolder(nestedDl, [...pathSegments, h3.textContent.trim()], out);
      }
    } else if (link) {
      const url = link.getAttribute('href');
      if (url && /^https?:\/\//i.test(url)) {
        out.push({
          url,
          title: link.textContent.trim(),
          category: pathSegments.length ? pathSegments.join('/') : null,
        });
      }
    }
  }
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

async function apiPatch(path, body) {
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    method: 'PATCH',
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

async function apiDelete(path) {
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || `Worker responded ${response.status}`);
  }
  return response.json();
}

// Refreshes every view that a bookmark add/edit/delete could have changed
// (category/tag counts in the sidebar, the datalist, the list itself).
async function refreshAfterMutation() {
  await Promise.all([loadCategories(), loadTags()]);
  await loadBookmarks({ reset: true });
}

// Asks background.js to mirror a Library add/edit/delete into this
// browser's native bookmarks (see its writeNativeCreate/Update/Delete).
// Errors are logged there, not surfaced here — the Worker call already
// succeeded by the time this is sent, so a failed native mirror shouldn't
// look like the Library action itself failed.
function notifyNativeWrite(type, payload) {
  browser.runtime.sendMessage({ type, ...payload }).catch((err) => {
    console.error(`[Library] ${type} message failed:`, err);
  });
}

function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
