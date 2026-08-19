import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireApiToken } from '../../middleware/require-api-token';
import { buildFtsMatchQuery, safeParseTags } from '../../lib/validation';

export const search = new Hono<AppEnv>();

search.use('*', requireApiToken);

/**
 * GET /api/v1/search?q=...
 * Full-text search over title/body_text/tags via the bookmarks_fts index.
 */
search.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  const ftsQuery = buildFtsMatchQuery(q);
  if (!ftsQuery) {
    return c.json({ results: [] });
  }

  const { repository } = c.get('deps');
  const results = await repository.search(ftsQuery);

  const parsed = results.map((row) => ({
    ...row,
    tags: safeParseTags(row.tags),
  }));

  return c.json({ query: q, results: parsed });
});
