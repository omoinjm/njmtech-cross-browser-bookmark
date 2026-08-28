import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import { MAX_CATEGORY_CHARS } from '../../lib/validation';

export const categories = new Hono<AppEnv>();

categories.use('*', requireSession);

/**
 * GET /api/v1/categories
 * Distinct categories with how many bookmarks carry each, most-used first.
 * Categories mirror real browser folder paths (or an AI suggestion for
 * unfiled bookmarks) — see bookmarks.ts and category-classifier.ts. Powers
 * the category sidebar on the extension's Library page, and is also the
 * existing-categories list the AI classifier picks from.
 */
categories.get('/', async (c) => {
  const user = c.get('user');
  const { repository } = c.get('deps');
  const results = await repository.listCategories(user.id);
  return c.json({ categories: results });
});

// Caps how many categorized bookmarks get fed into one reorg-suggestion
// prompt, bounding both the DB read and the prompt size for a very large
// library — see BookmarkRepository.listForReorg.
const MAX_REORG_BOOKMARKS = 500;

/**
 * POST /api/v1/categories/suggest-reorganization
 * Read-only: analyzes the current category list AND every categorized
 * bookmark's title, proposing both whole-category renames/merges and
 * individual misfiled-bookmark moves (see category-reorganizer.ts). Nothing
 * is changed by this call — see /reorganize to actually apply suggestions.
 */
categories.post('/suggest-reorganization', async (c) => {
  const user = c.get('user');
  const { repository, categoryReorganizer } = c.get('deps');
  const [currentCategories, candidateBookmarks] = await Promise.all([
    repository.listCategories(user.id),
    repository.listForReorg(user.id, MAX_REORG_BOOKMARKS),
  ]);
  const suggestions = await categoryReorganizer.suggest(currentCategories, candidateBookmarks);
  return c.json({ suggestions });
});

const MAX_REORG_BODY_BYTES = 64 * 1024;
const MAX_REORG_ITEMS = 200;

interface ReorgApplyItem {
  type?: string;
  from?: string;
  to?: string;
  bookmarkId?: number;
}

/**
 * POST /api/v1/categories/reorganize
 * Body: { items: [{ type: "category", from, to } | { type: "bookmark", bookmarkId, to }, ...] }
 *
 * Applies a mix of category-level and bookmark-level entries — normally the
 * (possibly user-edited) output of /suggest-reorganization, sent back
 * verbatim. Every entry is re-validated against the CURRENT state for the
 * calling user (never trusted from the request): a category `from` must
 * still be a real category *of theirs*, a bookmark's `to` must be a real
 * category the bookmark isn't already in, and the bookmark itself must
 * belong to them — `listByIds` below is scoped by `user.id`, which is the
 * only thing stopping one user from moving/renaming another user's
 * bookmarks by guessing an id. Entries that no longer validate are silently
 * dropped rather than erroring the whole request, since categories/
 * bookmarks may have changed between generating a suggestion and applying
 * it (or simply were never this user's to begin with).
 */
categories.post(
  '/reorganize',
  bodyLimit({
    maxSize: MAX_REORG_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  async (c) => {
    const payload = await c.req.json<{ items?: ReorgApplyItem[] }>().catch(() => null);
    const rawItems = payload?.items;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return c.json({ error: 'A non-empty "items" array is required' }, 400);
    }
    if (rawItems.length > MAX_REORG_ITEMS) {
      return c.json({ error: `A maximum of ${MAX_REORG_ITEMS} entries is supported` }, 400);
    }

    const user = c.get('user');
    const { repository } = c.get('deps');
    const currentCategories = await repository.listCategories(user.id);
    const validCategoryNames = new Set(currentCategories.map((cat) => cat.category));

    const categoryMapping = rawItems
      .filter((item) => item?.type === 'category')
      .map((item) => ({
        from: item.from?.trim() ?? '',
        to: item.to?.trim().slice(0, MAX_CATEGORY_CHARS) ?? '',
      }))
      .filter((item) => validCategoryNames.has(item.from) && item.to.length > 0 && item.to !== item.from);

    const bookmarkItems = rawItems.filter((item) => item?.type === 'bookmark');
    const bookmarkIds = bookmarkItems
      .map((item) => Number(item.bookmarkId))
      .filter((id) => Number.isInteger(id));
    const bookmarksById = new Map((await repository.listByIds(user.id, bookmarkIds)).map((b) => [b.id, b]));

    const bookmarkMoves = bookmarkItems
      .map((item) => ({
        id: Number(item.bookmarkId),
        to: item.to?.trim().slice(0, MAX_CATEGORY_CHARS) ?? '',
      }))
      .filter((item) => {
        const bookmark = bookmarksById.get(item.id);
        return Boolean(bookmark) && item.to.length > 0 && validCategoryNames.has(item.to) && item.to !== bookmark!.category;
      })
      .map((item) => ({ id: item.id, category: item.to }));

    if (categoryMapping.length === 0 && bookmarkMoves.length === 0) {
      return c.json(
        { error: 'No valid entries — categories or bookmarks may have changed since the suggestion was generated' },
        400
      );
    }

    await repository.applyReorganization(user.id, categoryMapping);
    await repository.applyBookmarkMoves(user.id, bookmarkMoves);

    return c.json({ applied: categoryMapping.length + bookmarkMoves.length });
  }
);
