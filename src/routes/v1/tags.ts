import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireApiToken } from '../../middleware/require-api-token';

export const tags = new Hono<AppEnv>();

tags.use('*', requireApiToken);

/**
 * GET /api/v1/tags
 * Distinct tags with how many bookmarks carry each, most-used first. Powers
 * the category sidebar on the extension's Library page.
 */
tags.get('/', async (c) => {
  const { repository } = c.get('deps');
  const results = await repository.listTags();
  return c.json({ tags: results });
});
