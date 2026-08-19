import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../http-context';
import { requireApiToken } from '../../middleware/require-api-token';
import { MAX_CATEGORY_CHARS } from '../../lib/validation';

export const categories = new Hono<AppEnv>();

categories.use('*', requireApiToken);

/**
 * GET /api/v1/categories
 * Distinct categories with how many bookmarks carry each, most-used first.
 * Categories mirror real browser folder paths (or an AI suggestion for
 * unfiled bookmarks) — see bookmarks.ts and category-classifier.ts. Powers
 * the category sidebar on the extension's Library page, and is also the
 * existing-categories list the AI classifier picks from.
 */
categories.get('/', async (c) => {
  const { repository } = c.get('deps');
  const results = await repository.listCategories();
  return c.json({ categories: results });
});

/**
 * POST /api/v1/categories/suggest-reorganization
 * Read-only: analyzes the current category list as a whole and proposes
 * renames/merges for poorly-organized ones (see category-reorganizer.ts).
 * Nothing is changed by this call — see /reorganize to actually apply a
 * mapping.
 */
categories.post('/suggest-reorganization', async (c) => {
  const { repository, categoryReorganizer } = c.get('deps');
  const currentCategories = await repository.listCategories();
  const suggestions = await categoryReorganizer.suggest(currentCategories);
  return c.json({ suggestions });
});

const MAX_REORG_BODY_BYTES = 64 * 1024;
const MAX_REORG_MAPPING_SIZE = 200;

/**
 * POST /api/v1/categories/reorganize
 * Body: { mapping: [{ from: string, to: string }, ...] }
 *
 * Applies a reorganization mapping — normally the (possibly user-edited)
 * output of /suggest-reorganization. Every `from` is re-validated against
 * the CURRENT category list (not trusted from the request), since categories
 * may have changed between generating a suggestion and applying it; entries
 * that no longer match a real category are silently dropped rather than
 * erroring the whole request.
 */
categories.post(
  '/reorganize',
  bodyLimit({
    maxSize: MAX_REORG_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  async (c) => {
    const payload = await c.req.json<{ mapping?: Array<{ from?: string; to?: string }> }>().catch(() => null);
    const rawMapping = payload?.mapping;

    if (!Array.isArray(rawMapping) || rawMapping.length === 0) {
      return c.json({ error: 'A non-empty "mapping" array is required' }, 400);
    }
    if (rawMapping.length > MAX_REORG_MAPPING_SIZE) {
      return c.json({ error: `A maximum of ${MAX_REORG_MAPPING_SIZE} mapping entries is supported` }, 400);
    }

    const { repository } = c.get('deps');
    const currentCategories = await repository.listCategories();
    const validFrom = new Set(currentCategories.map((c) => c.category));

    const mapping = rawMapping
      .map((item) => ({
        from: item?.from?.trim() ?? '',
        to: item?.to?.trim().slice(0, MAX_CATEGORY_CHARS) ?? '',
      }))
      .filter((item) => validFrom.has(item.from) && item.to.length > 0 && item.to !== item.from);

    if (mapping.length === 0) {
      return c.json(
        { error: 'No valid mapping entries — categories may have changed since the suggestion was generated' },
        400
      );
    }

    await repository.applyReorganization(mapping);
    return c.json({ applied: mapping.length });
  }
);
