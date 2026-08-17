import { Hono } from 'hono';
import { cors } from 'hono/cors';
import puppeteer from '@cloudflare/puppeteer';

/**
 * Bindings declared in wrangler.toml:
 *  - DB:      D1 database (bookmarks + bookmarks_fts)
 *  - AI:      Workers AI, used for auto-tagging
 *  - BROWSER: Browser Rendering, used to scrape title/body text
 */
export interface Env {
  DB: D1Database;
  AI: Ai;
  BROWSER: Fetcher;
}

type BookmarkRow = {
  id: number;
  url: string;
  title: string | null;
  body_text: string | null;
  tags: string | null;
  status: 'pending' | 'processed' | 'failed';
  created_at: string;
  updated_at: string;
};

const TAGGING_MODEL = '@cf/meta/llama-3.1-8b-instruct';

// Cap how much scraped text we persist / send to the model. Full page text
// isn't needed for tagging or search snippets, and keeping this bounded
// controls both D1 row size and Workers AI prompt cost.
const MAX_BODY_TEXT_CHARS = 4000;

const app = new Hono<{ Bindings: Env }>();

// Personal single-user tool talking to itself from an extension background
// worker — permissive CORS is fine here. Tighten `origin` if this ever gets
// a hosted frontend with a fixed domain.
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

app.get('/', (c) => c.json({ ok: true, service: 'bookmark-sync-engine' }));

/**
 * POST /bookmarks
 * Body: { url: string, title?: string }
 *
 * Saves the bookmark as "pending" and returns immediately. The scrape +
 * AI-tagging pipeline runs in the background via waitUntil() so the caller
 * (the browser extension, right after the user hits Cmd/Ctrl+D) never waits
 * on a slow headless-browser round trip.
 */
app.post('/bookmarks', async (c) => {
  const payload = await c.req.json<{ url?: string; title?: string }>().catch(() => null);
  const url = payload?.url?.trim();

  if (!url || !isHttpUrl(url)) {
    return c.json({ error: 'A valid "url" (http/https) is required' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id, status FROM bookmarks WHERE url = ?')
    .bind(url)
    .first<Pick<BookmarkRow, 'id' | 'status'>>();

  if (existing) {
    return c.json({ id: existing.id, status: existing.status, message: 'Bookmark already exists' }, 200);
  }

  // Store the browser-supplied title (if any) as an immediate fallback so
  // the record isn't blank while the scrape is still running in the background.
  const initialTitle = payload?.title?.trim() || null;

  const insert = await c.env.DB.prepare(
    `INSERT INTO bookmarks (url, title, status) VALUES (?, ?, 'pending')`
  )
    .bind(url, initialTitle)
    .run();

  const id = insert.meta.last_row_id;

  // Fire-and-forget background job. Cloudflare keeps the Worker instance
  // alive until this promise settles, even though the response above has
  // already been sent to the client.
  c.executionCtx.waitUntil(processBookmark(c.env, id, url));

  return c.json({ id, status: 'pending' }, 202);
});

/**
 * GET /search?q=...
 * Full-text search over title/body_text/tags via the bookmarks_fts index.
 */
app.get('/search', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ error: 'Query parameter "q" is required' }, 400);
  }

  const ftsQuery = buildFtsMatchQuery(q);
  if (!ftsQuery) {
    return c.json({ results: [] });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT
       b.id, b.url, b.title, b.tags, b.status, b.created_at,
       snippet(bookmarks_fts, 1, '<b>', '</b>', '…', 20) AS snippet,
       bm25(bookmarks_fts) AS rank
     FROM bookmarks_fts
     JOIN bookmarks b ON b.id = bookmarks_fts.rowid
     WHERE bookmarks_fts MATCH ?
     ORDER BY rank
     LIMIT 50`
  )
    .bind(ftsQuery)
    .all<BookmarkRow & { snippet: string; rank: number }>();

  const parsed = results.map((row) => ({
    ...row,
    tags: safeParseTags(row.tags),
  }));

  return c.json({ query: q, results: parsed });
});

/**
 * GET /bookmarks/:id
 * Convenience lookup, useful for the extension to poll processing status.
 */
app.get('/bookmarks/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Invalid id' }, 400);
  }

  const row = await c.env.DB.prepare('SELECT * FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<BookmarkRow>();

  if (!row) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({ ...row, tags: safeParseTags(row.tags) });
});

export default app;

// ---------------------------------------------------------------------------
// Background pipeline
// ---------------------------------------------------------------------------

/**
 * Scrapes the page via Browser Rendering, asks Workers AI for tags, and
 * writes the result back to D1. The bookmarks_au trigger in schema.sql keeps
 * bookmarks_fts in sync automatically — no manual FTS write needed here.
 */
async function processBookmark(env: Env, id: number, url: string): Promise<void> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });

    const title = await page.title();
    const rawBodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const bodyText = rawBodyText.trim().slice(0, MAX_BODY_TEXT_CHARS);

    const tags = await generateTags(env, title, bodyText);

    await env.DB.prepare(
      `UPDATE bookmarks
       SET title = ?, body_text = ?, tags = ?, status = 'processed', updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(title || url, bodyText, JSON.stringify(tags), id)
      .run();
  } catch (err) {
    console.error(`[processBookmark] failed for bookmark ${id} (${url}):`, err);
    await env.DB.prepare(
      `UPDATE bookmarks SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(id)
      .run();
  } finally {
    // Browser Rendering sessions are billed while open — always release it,
    // success or failure.
    await browser?.close().catch(() => {});
  }
}

/**
 * Asks the tagging model for 3-5 short category tags and defensively parses
 * the response, since LLMs occasionally wrap JSON in prose or markdown fences
 * despite instructions.
 */
async function generateTags(env: Env, title: string, bodyText: string): Promise<string[]> {
  if (!bodyText && !title) return [];

  try {
    const response = await env.AI.run(TAGGING_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You are a tagging assistant. Read the page title and content, then respond with ONLY ' +
            'a JSON array of 3 to 5 short, lowercase, single-or-two-word category tags. ' +
            'No prose, no markdown fences, no explanation — just the JSON array, e.g. ["ai","tooling","cloudflare"].',
        },
        {
          role: 'user',
          content: `Title: ${title}\n\nContent:\n${bodyText}`,
        },
      ],
    });

    const raw = typeof response === 'string' ? response : (response as { response?: string }).response ?? '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 5);
  } catch (err) {
    console.error('[generateTags] failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Builds a safe FTS5 MATCH expression from free-form user input. Each token
 * is quoted (so raw FTS5 operators like `-`, `"`, `:` in the user's query
 * can't break the syntax or be mistaken for column filters/NOT operators)
 * and suffixed with `*` for prefix matching, then AND-ed together.
 */
function buildFtsMatchQuery(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return null;

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function safeParseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
