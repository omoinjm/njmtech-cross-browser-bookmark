import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../http-context';
import type { BookmarkRow } from '../../env';
import { requireSession } from '../../middleware/require-session';
import { buildFtsMatchQuery, widenFtsMatchQuery, safeParseTags } from '../../lib/validation';

export const search = new Hono<AppEnv>();

search.use('*', requireSession);

const SEMANTIC_TOP_K = 20;
// Cosine similarity range is [-1, 1] (1 = identical meaning). Below this,
// a match is closer to noise than a real result — better to show fewer
// results than pad the list with unrelated bookmarks the model reached for.
const SEMANTIC_MIN_SCORE = 0.5;

/**
 * GET /api/v1/search?q=...&mode=keyword|semantic (default keyword)
 *
 * keyword (default): fast blind-index search over derived hashed terms from
 * url/title/body_text/tags/category. Raw D1/FTS inspection no longer reveals
 * bookmark plaintext, but the Worker can still widen a zero-result query with
 * AI-suggested related terms (drawn from the decrypted tags/categories
 * actually in use) so a query like "js" can still surface a bookmark tagged
 * "javascript".
 *
 * AI expansion only ever runs on a zero-result exact search, not every
 * search — an LLM asked to relate a query to a big tag/category list will
 * sometimes reach for generic, merely-popular terms even for a query that
 * doesn't actually relate to anything (confirmed live: a nonsense query
 * still got back terms like "ai"/"security" just because those are common
 * tags). Only doing this when the exact search already found nothing bounds
 * the damage to "you get some loosely-related results instead of none",
 * never "good exact results get diluted with irrelevant ones" — and it
 * keeps every search that already works from paying for an extra AI call.
 *
 * semantic: embeds the query and finds the nearest bookmark embeddings in
 * Vectorize (meaning-based, not keyword-based — surfaces a bookmark whose
 * title/body never mentions the query's words at all, as long as it's
 * conceptually related). Only covers bookmarks with an embedding already
 * (processed AND embedded_at set — see BookmarkIngestionPipeline and
 * /admin/backfill-embeddings for anything created before this existed).
 */
search.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  if (c.req.query('mode') === 'semantic') {
    return handleSemanticSearch(c, q);
  }

  const baseFtsQuery = buildFtsMatchQuery(q);
  if (baseFtsQuery.length === 0) {
    return c.json({ results: [] });
  }

  const user = c.get('user');
  const { repository, searchQueryExpander } = c.get('deps');

  const exactResults = await repository.search(user.id, [baseFtsQuery]);
  if (exactResults.length > 0) {
    return c.json({
      query: q,
      results: exactResults.map((row) => ({ ...row, tags: safeParseTags(row.tags), snippet: buildHighlightedSnippet(row, baseFtsQuery) })),
    });
  }

  const [tagCounts, categoryCounts] = await Promise.all([repository.listTags(user.id), repository.listCategories(user.id)]);
  const expandedTerms = await searchQueryExpander.expand(
    q,
    tagCounts.map((t) => t.tag),
    categoryCounts.map((c) => c.category)
  );

  if (expandedTerms.length === 0) {
    return c.json({ query: q, results: [] });
  }

  const widenedGroups = widenFtsMatchQuery(baseFtsQuery, expandedTerms);
  const widenedResults = await repository.search(user.id, widenedGroups);
  const allWidenedTerms = widenedGroups.flat();
  const parsed = widenedResults.map((row) => ({
    ...row,
    tags: safeParseTags(row.tags),
    snippet: buildHighlightedSnippet(row, allWidenedTerms),
  }));

  return c.json({ query: q, expandedTerms, results: parsed });
});

async function handleSemanticSearch(c: Context<AppEnv>, q: string) {
  const user = c.get('user');
  const { repository, embeddingGenerator, semanticIndex } = c.get('deps');

  const vector = await embeddingGenerator.embed(q);
  const matches = (await semanticIndex.query(vector, user.id, SEMANTIC_TOP_K)).filter(
    (m) => m.score >= SEMANTIC_MIN_SCORE
  );

  if (matches.length === 0) {
    return c.json({ query: q, results: [] });
  }

  const rows = await repository.listBookmarksByIds(user.id, matches.map((m) => m.id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  // Preserve Vectorize's own relevance ordering — listBookmarksByIds doesn't
  // guarantee it matches the input id order. A match with no row anymore
  // (deleted since it was embedded, before its vector cleanup ran) is just
  // skipped rather than erroring the whole search.
  const results = matches
    .map((m) => rowsById.get(m.id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({ ...row, tags: safeParseTags(row.tags) }));

  return c.json({ query: q, results });
}

const SNIPPET_MARK_START = '';
const SNIPPET_MARK_END = '';
// Chars of context kept on each side of the first match, mirroring FTS5's
// own snippet() sizing (which we can no longer use — bookmarks_fts only
// ever stores hashed terms, never real text, see bookmark-encryption.ts).
const SNIPPET_RADIUS = 60;

/**
 * Rebuilds a readable, highlighted snippet from a result's own decrypted
 * content (already hydrated by repository.search by the time this runs).
 * Searches body_text/title/url, in that preference order, for the literal
 * terms that drove the match, and wraps each occurrence in SNIPPET_MARK_*
 * markers — see appendHighlightedSnippet in the extension for how those
 * get turned into <mark> elements.
 */
function buildHighlightedSnippet(bookmark: Pick<BookmarkRow, 'title' | 'body_text' | 'url'>, terms: string[]): string | undefined {
  const uniqueTerms = [...new Set(terms)].filter(Boolean);
  if (uniqueTerms.length === 0) return undefined;

  const pattern = new RegExp(uniqueTerms.map(escapeRegExp).join('|'), 'giu');

  for (const candidate of [bookmark.body_text, bookmark.title, bookmark.url]) {
    if (!candidate) continue;

    pattern.lastIndex = 0;
    const firstMatch = pattern.exec(candidate);
    if (!firstMatch) continue;

    const windowStart = Math.max(0, firstMatch.index - SNIPPET_RADIUS);
    const windowEnd = Math.min(candidate.length, firstMatch.index + firstMatch[0].length + SNIPPET_RADIUS);
    const prefix = windowStart > 0 ? '…' : '';
    const suffix = windowEnd < candidate.length ? '…' : '';

    pattern.lastIndex = 0;
    const highlighted = candidate
      .slice(windowStart, windowEnd)
      .replace(pattern, (match) => `${SNIPPET_MARK_START}${match}${SNIPPET_MARK_END}`);

    return `${prefix}${highlighted}${suffix}`;
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
