import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireApiToken } from '../../middleware/require-api-token';
import { buildFtsMatchQuery, widenFtsMatchQuery, safeParseTags } from '../../lib/validation';

export const search = new Hono<AppEnv>();

search.use('*', requireApiToken);

const SEMANTIC_TOP_K = 20;
// Cosine similarity range is [-1, 1] (1 = identical meaning). Below this,
// a match is closer to noise than a real result — better to show fewer
// results than pad the list with unrelated bookmarks the model reached for.
const SEMANTIC_MIN_SCORE = 0.5;

/**
 * GET /api/v1/search?q=...&mode=keyword|semantic (default keyword)
 *
 * keyword (default): full-text search over title/body_text/tags/category via
 * the bookmarks_fts index. If the exact-match query comes up empty, falls
 * back to widening it with AI-suggested related terms (drawn from the tags
 * and categories actually in use) so a query like "js" can still surface a
 * bookmark titled/tagged "javascript" even though plain prefix matching
 * wouldn't connect the two.
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
  if (!baseFtsQuery) {
    return c.json({ results: [] });
  }

  const { repository, searchQueryExpander } = c.get('deps');

  const exactResults = await repository.search(baseFtsQuery);
  if (exactResults.length > 0) {
    return c.json({ query: q, results: exactResults.map((row) => ({ ...row, tags: safeParseTags(row.tags) })) });
  }

  const [tagCounts, categoryCounts] = await Promise.all([repository.listTags(), repository.listCategories()]);
  const expandedTerms = await searchQueryExpander.expand(
    q,
    tagCounts.map((t) => t.tag),
    categoryCounts.map((c) => c.category)
  );

  if (expandedTerms.length === 0) {
    return c.json({ query: q, results: [] });
  }

  const widenedResults = await repository.search(widenFtsMatchQuery(baseFtsQuery, expandedTerms));
  const parsed = widenedResults.map((row) => ({ ...row, tags: safeParseTags(row.tags) }));

  return c.json({ query: q, expandedTerms, results: parsed });
});

async function handleSemanticSearch(c: Context<AppEnv>, q: string) {
  const { repository, embeddingGenerator, semanticIndex } = c.get('deps');

  const vector = await embeddingGenerator.embed(q);
  const matches = (await semanticIndex.query(vector, SEMANTIC_TOP_K)).filter((m) => m.score >= SEMANTIC_MIN_SCORE);

  if (matches.length === 0) {
    return c.json({ query: q, results: [] });
  }

  const rows = await repository.listBookmarksByIds(matches.map((m) => m.id));
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
