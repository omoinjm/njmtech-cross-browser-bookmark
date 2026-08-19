export const MAX_URL_CHARS = 2048;
export const MAX_TITLE_CHARS = 500;
export const MAX_CATEGORY_CHARS = 200;

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

/**
 * Builds a safe FTS5 MATCH expression from free-form user input. Each token
 * is quoted (so raw FTS5 operators like `-`, `"`, `:` in the user's query
 * can't break the syntax or be mistaken for column filters/NOT operators)
 * and suffixed with `*` for prefix matching, then AND-ed together.
 */
export function buildFtsMatchQuery(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return null;

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
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
