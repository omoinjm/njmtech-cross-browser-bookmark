import type { BookmarkRow, BookmarkSearchResult, TagCount, CategoryCount, ReorgBookmarkRow } from '../env';

export interface ListBookmarksOptions {
  tag?: string;
  category?: string;
  limit: number;
  offset: number;
}

// A key's absence leaves that field untouched; an explicit `null` clears it
// (relevant for category, which goes null when a bookmark moves out of every
// real folder back to "unfiled").
export interface UpdateBookmarkFields {
  title?: string | null;
  category?: string | null;
  tags?: string[];
}

/**
 * All persistence access the rest of the app needs, expressed as an
 * abstraction. Route handlers and the ingestion pipeline depend on this
 * interface, never on D1Database directly — swapping storage engines only
 * means writing a new implementation of this interface.
 *
 * Every method below takes a `userId` and enforces it in its SQL — this is
 * a hard multi-tenant security boundary, not a convenience filter. In
 * particular `listByIds`/`listBookmarksByIds` must never return a row
 * belonging to a different user: categories.ts's /reorganize route trusts a
 * client-supplied bookmarkId, and that ownership check is the only thing
 * stopping one user from moving/renaming another user's bookmarks.
 */
export interface BookmarkRepository {
  findByUrl(userId: number, url: string): Promise<Pick<BookmarkRow, 'id' | 'status' | 'category' | 'embedded_at'> | null>;
  findById(userId: number, id: number): Promise<BookmarkRow | null>;
  create(userId: number, url: string, initialTitle: string | null, category: string | null): Promise<number>;
  list(userId: number, options: ListBookmarksOptions): Promise<BookmarkRow[]>;
  listTags(userId: number): Promise<TagCount[]>;
  listCategories(userId: number): Promise<CategoryCount[]>;
  listUrlCategories(userId: number): Promise<Array<{ url: string; category: string | null }>>;
  search(userId: number, ftsMatchQuery: string): Promise<BookmarkSearchResult[]>;
  markProcessed(id: number, title: string, bodyText: string, tags: string[]): Promise<void>;
  markFailed(id: number): Promise<void>;
  updateCategory(id: number, category: string): Promise<void>;
  applyReorganization(userId: number, mapping: Array<{ from: string; to: string }>): Promise<void>;
  /** Categorized bookmarks only, capped at `limit` — feeds the reorg-suggestion prompt. */
  listForReorg(userId: number, limit: number): Promise<ReorgBookmarkRow[]>;
  /** Re-fetches bookmarks by id to re-validate a bookmark-move suggestion right before applying it. */
  listByIds(userId: number, ids: number[]): Promise<ReorgBookmarkRow[]>;
  applyBookmarkMoves(userId: number, moves: Array<{ id: number; category: string }>): Promise<void>;
  /** Full rows (unlike listByIds' lightweight shape) — used to hydrate semantic search matches. */
  listBookmarksByIds(userId: number, ids: number[]): Promise<BookmarkRow[]>;
  markEmbedded(id: number): Promise<void>;
  /** Processed, owned, unembedded bookmarks, capped at `limit` — feeds POST /admin/backfill-embeddings (cross-user by design, an admin sweep). */
  listUnembeddedProcessed(limit: number): Promise<BookmarkRow[]>;
  /** Returns false when no bookmark has this url for this user — the route turns that into a 404. */
  updateByUrl(userId: number, url: string, fields: UpdateBookmarkFields): Promise<boolean>;
  /** Returns the deleted bookmark's id (so its embedding can be removed too), or null if this user had no bookmark at this url. */
  deleteByUrl(userId: number, url: string): Promise<number | null>;
}

export class D1BookmarkRepository implements BookmarkRepository {
  constructor(private readonly db: D1Database) {}

  async findByUrl(userId: number, url: string): Promise<Pick<BookmarkRow, 'id' | 'status' | 'category' | 'embedded_at'> | null> {
    return this.db
      .prepare('SELECT id, status, category, embedded_at FROM bookmarks WHERE user_id = ? AND url = ?')
      .bind(userId, url)
      .first<Pick<BookmarkRow, 'id' | 'status' | 'category' | 'embedded_at'>>();
  }

  async findById(userId: number, id: number): Promise<BookmarkRow | null> {
    return this.db.prepare('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?').bind(id, userId).first<BookmarkRow>();
  }

  async create(userId: number, url: string, initialTitle: string | null, category: string | null): Promise<number> {
    const insert = await this.db
      .prepare(`INSERT INTO bookmarks (user_id, url, title, category, status) VALUES (?, ?, ?, ?, 'pending')`)
      .bind(userId, url, initialTitle, category)
      .run();

    return insert.meta.last_row_id;
  }

  async list(userId: number, { tag, category, limit, offset }: ListBookmarksOptions): Promise<BookmarkRow[]> {
    if (tag) {
      const { results } = await this.db
        .prepare(
          `SELECT b.id, b.url, b.title, b.body_text, b.tags, b.category, b.status, b.created_at, b.updated_at
           FROM bookmarks b, json_each(b.tags) je
           WHERE b.user_id = ? AND je.value = ?
           ORDER BY b.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(userId, tag, limit, offset)
        .all<BookmarkRow>();
      return results;
    }

    if (category) {
      const { results } = await this.db
        .prepare(`SELECT * FROM bookmarks WHERE user_id = ? AND category = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .bind(userId, category, limit, offset)
        .all<BookmarkRow>();
      return results;
    }

    const { results } = await this.db
      .prepare(`SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(userId, limit, offset)
      .all<BookmarkRow>();
    return results;
  }

  async listTags(userId: number): Promise<TagCount[]> {
    const { results } = await this.db
      .prepare(
        `SELECT je.value AS tag, COUNT(*) AS count
         FROM bookmarks b, json_each(b.tags) je
         WHERE b.user_id = ?
         GROUP BY je.value
         ORDER BY count DESC, tag ASC`
      )
      .bind(userId)
      .all<TagCount>();
    return results;
  }

  async listCategories(userId: number): Promise<CategoryCount[]> {
    const { results } = await this.db
      .prepare(
        `SELECT category, COUNT(*) AS count
         FROM bookmarks
         WHERE user_id = ? AND category IS NOT NULL AND category != ''
         GROUP BY category
         ORDER BY count DESC, category ASC`
      )
      .bind(userId)
      .all<CategoryCount>();
    return results;
  }

  // Powers the extension's re-import skip check: it needs every URL's
  // current stored category up front so it can avoid re-POSTing bookmarks
  // whose folder-derived category hasn't changed since the last import.
  async listUrlCategories(userId: number): Promise<Array<{ url: string; category: string | null }>> {
    const { results } = await this.db
      .prepare(`SELECT url, category FROM bookmarks WHERE user_id = ?`)
      .bind(userId)
      .all<{ url: string; category: string | null }>();
    return results;
  }

  async search(userId: number, ftsMatchQuery: string): Promise<BookmarkSearchResult[]> {
    // Markers are U+0001/U+0002, not literal HTML tags: the snippet's source
    // text is a scraped page's own visible text (untrusted), so a client
    // rendering this via innerHTML around literal <b>/</b> would let a
    // bookmarked page's own text content inject markup. Control characters
    // can't collide with real page text, and the client splits on them to
    // build highlight nodes safely instead — see extension/library.js.
    const { results } = await this.db
      .prepare(
        `SELECT
           b.id, b.url, b.title, b.tags, b.category, b.status, b.created_at,
           snippet(bookmarks_fts, 1, char(1), char(2), '…', 20) AS snippet,
           bm25(bookmarks_fts) AS rank
         FROM bookmarks_fts
         JOIN bookmarks b ON b.id = bookmarks_fts.rowid
         WHERE bookmarks_fts MATCH ? AND b.user_id = ?
         ORDER BY rank
         LIMIT 50`
      )
      .bind(ftsMatchQuery, userId)
      .all<BookmarkSearchResult>();

    return results;
  }

  async markProcessed(id: number, title: string, bodyText: string, tags: string[]): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bookmarks
         SET title = ?, body_text = ?, tags = ?, status = 'processed', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(title, bodyText, JSON.stringify(tags), id)
      .run();
  }

  async markFailed(id: number): Promise<void> {
    await this.db
      .prepare(`UPDATE bookmarks SET status = 'failed', updated_at = datetime('now') WHERE id = ?`)
      .bind(id)
      .run();
  }

  // Called either by the ingestion pipeline's AI category-suggestion step
  // (for a bookmark with no real folder to derive a category from), or by
  // the dedupe path in POST /bookmarks when a re-synced bookmark's real
  // folder-derived category differs from what's currently stored. Both
  // callers already resolved `id` through an owner-checked path, so no
  // separate user_id check is needed here.
  async updateCategory(id: number, category: string): Promise<void> {
    await this.db
      .prepare(`UPDATE bookmarks SET category = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(category, id)
      .run();
  }

  // One UPDATE per mapping entry, run as a single D1 batch (one round trip,
  // applied atomically) rather than a loop of awaited individual queries.
  // The route validates every `from` against the CURRENT category list for
  // this same user immediately before calling this — see categories.ts.
  async applyReorganization(userId: number, mapping: Array<{ from: string; to: string }>): Promise<void> {
    if (mapping.length === 0) return;

    const statements = mapping.map(({ from, to }) =>
      this.db
        .prepare(`UPDATE bookmarks SET category = ?, updated_at = datetime('now') WHERE user_id = ? AND category = ?`)
        .bind(to, userId, from)
    );

    await this.db.batch(statements);
  }

  async listForReorg(userId: number, limit: number): Promise<ReorgBookmarkRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, url, title, category FROM bookmarks
         WHERE user_id = ? AND category IS NOT NULL AND category != ''
         ORDER BY category, id
         LIMIT ?`
      )
      .bind(userId, limit)
      .all<ReorgBookmarkRow>();
    return results;
  }

  async listByIds(userId: number, ids: number[]): Promise<ReorgBookmarkRow[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`SELECT id, url, title, category FROM bookmarks WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...ids)
      .all<ReorgBookmarkRow>();
    return results;
  }

  async applyBookmarkMoves(userId: number, moves: Array<{ id: number; category: string }>): Promise<void> {
    if (moves.length === 0) return;

    const statements = moves.map(({ id, category }) =>
      this.db
        .prepare(`UPDATE bookmarks SET category = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
        .bind(category, id, userId)
    );

    await this.db.batch(statements);
  }

  async listBookmarksByIds(userId: number, ids: number[]): Promise<BookmarkRow[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`SELECT * FROM bookmarks WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...ids)
      .all<BookmarkRow>();
    return results;
  }

  async markEmbedded(id: number): Promise<void> {
    await this.db.prepare(`UPDATE bookmarks SET embedded_at = datetime('now') WHERE id = ?`).bind(id).run();
  }

  async listUnembeddedProcessed(limit: number): Promise<BookmarkRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM bookmarks
         WHERE status = 'processed' AND embedded_at IS NULL AND user_id IS NOT NULL
         LIMIT ?`
      )
      .bind(limit)
      .all<BookmarkRow>();
    return results;
  }

  // Builds the SET clause from whichever keys are actually present in
  // `fields` — see UpdateBookmarkFields' doc comment for why presence (not
  // truthiness) is what matters here.
  async updateByUrl(userId: number, url: string, fields: UpdateBookmarkFields): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if ('title' in fields) {
      sets.push('title = ?');
      values.push(fields.title ?? null);
    }
    if ('category' in fields) {
      sets.push('category = ?');
      values.push(fields.category ?? null);
    }
    if ('tags' in fields) {
      sets.push('tags = ?');
      values.push(JSON.stringify(fields.tags ?? []));
    }

    if (sets.length === 0) return false;

    sets.push(`updated_at = datetime('now')`);
    values.push(userId, url);

    const result = await this.db
      .prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE user_id = ? AND url = ?`)
      .bind(...values)
      .run();

    return result.meta.changes > 0;
  }

  async deleteByUrl(userId: number, url: string): Promise<number | null> {
    const deleted = await this.db
      .prepare('DELETE FROM bookmarks WHERE user_id = ? AND url = ? RETURNING id')
      .bind(userId, url)
      .first<{ id: number }>();
    return deleted?.id ?? null;
  }
}
