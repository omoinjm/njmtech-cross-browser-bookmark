// Live star/fork counts via GitHub's public REST API — unauthenticated,
// CORS-enabled, no build step needed. One fetch per page load; a 403 (rate
// limited) or network failure just leaves the "—" placeholders in place
// rather than showing a broken loading state.
const REPO = 'omoinjm/njmtech-cross-browser-bookmark';

async function loadRepoStats() {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`);
    if (!response.ok) return;

    const data = await response.json();
    document.getElementById('stat-stars').textContent = formatCount(data.stargazers_count);
    document.getElementById('stat-forks').textContent = formatCount(data.forks_count);
  } catch (err) {
    console.error('[website] Failed to load GitHub repo stats:', err);
  }
}

function formatCount(n) {
  if (typeof n !== 'number') return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

loadRepoStats();
