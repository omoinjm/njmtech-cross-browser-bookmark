import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import { requireProfile } from '../../middleware/require-profile';

export const tags = new Hono<AppEnv>();

tags.use('*', requireSession);
tags.use('*', requireProfile);

/**
 * GET /api/v1/tags
 * Distinct tags with how many bookmarks carry each, most-used first. Powers
 * the category sidebar on the extension's Library page.
 */
tags.get('/', async (c) => {
  const user = c.get('user');
  const profile = c.get('profile');
  const { repository } = c.get('deps');
  const results = await repository.listTags(user.id, profile.id);
  return c.json({ tags: results });
});
