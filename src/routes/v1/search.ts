import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireApiToken } from '../../middleware/require-api-token';
import { buildFtsMatchQuery, widenFtsMatchQuery, safeParseTags } from '../../lib/validation';

export const search = new Hono<AppEnv>();

search.use('*', requireApiToken);

/**
 * GET /api/v1/search?q=...
 * Full-text search over title/body_text/tags/category via the bookmarks_fts
 * index. If the exact-match query comes up empty, falls back to widening it
 * with AI-suggested related terms (drawn from the tags and categories
 * actually in use) so a query like "js" can still surface a bookmark
 * titled/tagged "javascript" even though plain prefix matching wouldn't
 * connect the two.
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
 */
search.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
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
