import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../http-context';
import { requireApiToken } from '../../middleware/require-api-token';
import {
  isHttpUrl,
  isPubliclyRoutableUrl,
  safeParseTags,
  MAX_URL_CHARS,
  MAX_TITLE_CHARS,
  MAX_CATEGORY_CHARS,
} from '../../lib/validation';

export const bookmarks = new Hono<AppEnv>();

bookmarks.use('*', requireApiToken);

// The payload is just { url, title } — 8KB is generous headroom, and capping
// it stops a maliciously huge body from being parsed/stored for free.
const MAX_BODY_BYTES = 8 * 1024;

/**
 * POST /api/v1/bookmarks
 * Body: { url: string, title?: string, category?: string, suggestCategory?: boolean }
 *
 * `category`, when present, is taken as-is (the extension derives it from
 * the bookmark's real browser folder path) and is never overwritten later.
 * `suggestCategory` only takes effect when `category` is absent — it asks
 * the background pipeline to pick a best-fit category from ones already in
 * use, via Workers AI. If both are absent, the bookmark stays uncategorized.
 *
 * Saves the bookmark as "pending" and returns immediately. The scrape +
 * AI-tagging (+ optional AI-categorizing) pipeline runs in the background
 * via waitUntil() so the caller (the browser extension, right after the
 * user hits Cmd/Ctrl+D) never waits on a slow headless-browser round trip.
 */
bookmarks.post(
  '/',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  async (c) => {
    const payload = await c
      .req.json<{ url?: string; title?: string; category?: string; suggestCategory?: boolean }>()
      .catch(() => null);
    const url = payload?.url?.trim();

    if (!url || url.length > MAX_URL_CHARS || !isHttpUrl(url) || !isPubliclyRoutableUrl(url)) {
      return c.json({ error: 'A valid public "url" (http/https) is required' }, 400);
    }

    const { repository, pipeline } = c.get('deps');
    const category = payload?.category?.trim().slice(0, MAX_CATEGORY_CHARS) || null;

    const existing = await repository.findByUrl(url);
    if (existing) {
      // A folder-derived `category` always reflects where the bookmark
      // really lives right now, so it's safe to overwrite whatever was
      // stored before (backfilling a null, or following the user moving it
      // to a different real folder between imports) — it's never an AI
      // guess. Dedupe would otherwise silently skip this bookmark forever,
      // since the create()/process() path below never runs for it again.
      if (category && category !== existing.category) {
        await repository.updateCategory(existing.id, category);
      } else if (!existing.category && payload?.suggestCategory) {
        c.executionCtx.waitUntil(pipeline.categorizeExisting(existing.id));
      }
      return c.json({ id: existing.id, status: existing.status, message: 'Bookmark already exists' }, 200);
    }

    // Store the browser-supplied title (if any) as an immediate fallback so
    // the record isn't blank while the scrape is still running in the
    // background. Truncated defensively — this is a display hint, not
    // load-bearing data.
    const initialTitle = payload?.title?.trim().slice(0, MAX_TITLE_CHARS) || null;
    const id = await repository.create(url, initialTitle, category);

    // Only ever suggest a category when none was supplied — a real folder
    // path always wins, regardless of what the client sent for this flag.
    const suggestCategory = Boolean(payload?.suggestCategory) && !category;

    // Fire-and-forget background job. Cloudflare keeps the Worker instance
    // alive until this promise settles, even though the response above has
    // already been sent to the client.
    c.executionCtx.waitUntil(pipeline.process(id, url, { suggestCategory }));

    return c.json({ id, status: 'pending' }, 202);
  }
);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * GET /api/v1/bookmarks?tag=...&category=...&limit=...&offset=...
 * Lists bookmarks, most recent first, optionally filtered to one tag or one
 * category (not both — tag takes priority if both are given). Powers the
 * extension's Library page.
 */
bookmarks.get('/', async (c) => {
  const tag = c.req.query('tag')?.trim() || undefined;
  const category = tag ? undefined : c.req.query('category')?.trim() || undefined;
  const limit = clampInt(c.req.query('limit'), 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const offset = clampInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER, 0);

  const { repository } = c.get('deps');
  const rows = await repository.list({ tag, category, limit, offset });

  return c.json({
    bookmarks: rows.map((row) => ({ ...row, tags: safeParseTags(row.tags) })),
    limit,
    offset,
  });
});

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * GET /api/v1/bookmarks/url-categories
 * Returns every stored bookmark's URL mapped to its current category, as a
 * single lightweight payload (no title/body/tags). The extension fetches
 * this once before a re-import to skip re-POSTing any bookmark whose real
 * folder-derived category hasn't changed since last time — avoiding one
 * network round trip per already-synced, unchanged bookmark.
 *
 * Registered above /:id so it isn't captured by that dynamic param route.
 */
bookmarks.get('/url-categories', async (c) => {
  const { repository } = c.get('deps');
  const rows = await repository.listUrlCategories();

  const categories: Record<string, string | null> = {};
  for (const row of rows) {
    categories[row.url] = row.category;
  }

  return c.json({ categories });
});

/**
 * GET /api/v1/bookmarks/:id
 * Convenience lookup, useful for the extension to poll processing status.
 */
bookmarks.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Invalid id' }, 400);
  }

  const { repository } = c.get('deps');
  const row = await repository.findById(id);

  if (!row) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({ ...row, tags: safeParseTags(row.tags) });
});
