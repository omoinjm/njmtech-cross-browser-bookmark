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

(async function init() {
  const { syncState, recentActivity, settings } = await browser.storage.local.get([
    'syncState',
    'recentActivity',
    'settings',
  ]);
  renderProgress(syncState);
  renderActivity(recentActivity);
  suggestCategoryToggle.checked = Boolean(settings?.suggestCategoryForUnfiled);
})();
