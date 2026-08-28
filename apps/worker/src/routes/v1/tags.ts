import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';

export const tags = new Hono<AppEnv>();

tags.use('*', requireSession);

/**
 * GET /api/v1/tags
 * Distinct tags with how many bookmarks carry each, most-used first. Powers
 * the category sidebar on the extension's Library page.
 */
tags.get('/', async (c) => {
  const user = c.get('user');
  const { repository } = c.get('deps');
  const results = await repository.listTags(user.id);
  return c.json({ tags: results });
});
