export const MAX_URL_CHARS = 2048;
export const MAX_TITLE_CHARS = 500;
export const MAX_CATEGORY_CHARS = 200;
export const MAX_TAG_CHARS = 50;
export const MAX_TAGS_COUNT = 20;

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Blocks the obvious loopback/private/link-local targets (including
// 169.254.169.254, the #1 SSRF target for cloud metadata endpoints) before
// we hand a user-supplied URL to Browser Rendering. This is a literal
// hostname check, not DNS-based: it doesn't catch DNS rebinding, but Workers
// has no raw DNS resolution API to do better, and it stops the trivial case
// of someone bookmarking "http://169.254.169.254/" or "http://localhost/".
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
];

export function isPubliclyRoutableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return !PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
  } catch {
    return false;
  }
}

/** Extracts normalized keyword-search tokens from free-form user input. */
export function buildFtsMatchQuery(input: string): string[] {
  return normalizeSearchTerms(input);
}

/**
 * Broadens a base keyword-search token list with AI-suggested related terms.
 * The first entry remains the user's original AND-ed token group; each extra
 * entry is an alternative token group the repository ORs in via its blind
 * search index.
 */
export function widenFtsMatchQuery(baseQuery: string[], expansionTerms: string[]): string[][] {
  const groups = [baseQuery].filter((group) => group.length > 0);
  for (const term of expansionTerms) {
    const normalized = normalizeSearchTerms(term);
    if (normalized.length > 0) groups.push(normalized);
  }
  return groups;
}

export function safeParseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Validates a client-supplied tags array for PATCH /bookmarks (manual edits,
 * as opposed to the AI tagger's own output, which is already trusted and
 * bypasses this). Returns null only when `value` isn't an array at all —
 * individual bad entries are filtered out rather than rejecting the whole
 * request, matching how title/category are truncated instead of rejected.
 */
export function sanitizeTagsInput(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  return value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().slice(0, MAX_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TAGS_COUNT);
}

function normalizeSearchTerms(input: string): string[] {
  return (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}
