import type { BookmarkRow, BookmarkSearchResult, TagCount, CategoryCount, ReorgBookmarkRow } from '../env';
import type { BookmarkEncryptionService } from '../services/bookmark-encryption';

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

interface StoredBookmarkRow {
  id: number;
  user_id: number | null;
  url: string | null;
  title: string | null;
  body_text: string | null;
  tags: string | null;
  category: string | null;
  url_encrypted: string | null;
  title_encrypted: string | null;
  body_text_encrypted: string | null;
  tags_encrypted: string | null;
  category_encrypted: string | null;
  url_lookup: string | null;
  category_lookup: string | null;
  status: BookmarkRow['status'];
  created_at: string;
  updated_at: string;
  embedded_at: string | null;
  rank?: number;
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
  search(userId: number, termGroups: string[][]): Promise<BookmarkSearchResult[]>;
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
  /** One batch of legacy plaintext rows -> encrypted rows + derived lookup/index artifacts. */
  backfillEncryption(limit: number): Promise<{ migrated: number; moreRemaining: boolean }>;
}

export class D1BookmarkRepository implements BookmarkRepository {
  constructor(
    private readonly db: D1Database,
    private readonly encryption: BookmarkEncryptionService
  ) {}

  async findByUrl(userId: number, url: string): Promise<Pick<BookmarkRow, 'id' | 'status' | 'category' | 'embedded_at'> | null> {
    const row = await this.findStoredByUrl(userId, url);
    if (!row) return null;

    return {
      id: row.id,
      status: row.status,
      category: await this.encryption.decryptField(row.category_encrypted, row.category),
      embedded_at: row.embedded_at,
    };
  }

  async findById(userId: number, id: number): Promise<BookmarkRow | null> {
    const row = await this.db
      .prepare(`${BASE_SELECT} WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<StoredBookmarkRow>();
    return row ? this.hydrateRow(row) : null;
  }

  async create(userId: number, url: string, initialTitle: string | null, category: string | null): Promise<number> {
    const stored = await this.encryption.pack({ url, title: initialTitle, bodyText: null, tags: [], category });
    const insert = await this.db
      .prepare(
        `INSERT INTO bookmarks (
           user_id, url, title, body_text, tags, category,
           url_encrypted, title_encrypted, body_text_encrypted, tags_encrypted, category_encrypted,
           url_lookup, category_lookup, status
         ) VALUES (?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .bind(
        userId,
        stored.urlEncrypted,
        stored.titleEncrypted,
        stored.bodyTextEncrypted,
        stored.tagsEncrypted,
        stored.categoryEncrypted,
        stored.urlLookup,
        stored.categoryLookup
      )
      .run();

    const id = insert.meta.last_row_id;
    await this.replaceDerivedArtifacts(id, userId, stored.searchDocument, stored.tagLookups);
    return id;
  }

  async list(userId: number, { tag, category, limit, offset }: ListBookmarksOptions): Promise<BookmarkRow[]> {
    if (tag) {
      const tagLookup = await this.encryption.buildTagLookup(tag);
      const { results } = await this.db
        .prepare(
          `SELECT b.*
           FROM bookmark_tag_lookup tl
           JOIN bookmarks b ON b.id = tl.bookmark_id
           WHERE tl.user_id = ? AND tl.tag_lookup = ?
           ORDER BY b.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(userId, tagLookup, limit, offset)
        .all<StoredBookmarkRow>();
      return Promise.all(results.map((row) => this.hydrateRow(row)));
    }

    if (category) {
      const categoryLookup = await this.encryption.buildCategoryLookup(category);
      const { results } = await this.db
        .prepare(
          `${BASE_SELECT}
           WHERE user_id = ? AND (category_lookup = ? OR (category_lookup IS NULL AND category = ?))
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(userId, categoryLookup, category, limit, offset)
        .all<StoredBookmarkRow>();
      return Promise.all(results.map((row) => this.hydrateRow(row)));
    }

    const { results } = await this.db
      .prepare(`${BASE_SELECT} WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(userId, limit, offset)
      .all<StoredBookmarkRow>();
    return Promise.all(results.map((row) => this.hydrateRow(row)));
  }

  async listTags(userId: number): Promise<TagCount[]> {
    const { results } = await this.db
      .prepare(`SELECT tags, tags_encrypted FROM bookmarks WHERE user_id = ?`)
      .bind(userId)
      .all<Pick<StoredBookmarkRow, 'tags' | 'tags_encrypted'>>();

    const counts = new Map<string, number>();
    for (const row of results) {
      const rawTags = await this.encryption.decryptField(row.tags_encrypted, row.tags);
      if (!rawTags) continue;
      for (const tag of safeParseStoredTags(rawTags)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  }

  async listCategories(userId: number): Promise<CategoryCount[]> {
    const { results } = await this.db
      .prepare(`SELECT category, category_encrypted FROM bookmarks WHERE user_id = ?`)
      .bind(userId)
      .all<Pick<StoredBookmarkRow, 'category' | 'category_encrypted'>>();

    const counts = new Map<string, number>();
    for (const row of results) {
      const category = await this.encryption.decryptField(row.category_encrypted, row.category);
      if (!category) continue;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => (b.count - a.count) || a.category.localeCompare(b.category));
  }

  async listUrlCategories(userId: number): Promise<Array<{ url: string; category: string | null }>> {
    const { results } = await this.db
      .prepare(`SELECT url, url_encrypted, category, category_encrypted FROM bookmarks WHERE user_id = ?`)
      .bind(userId)
      .all<Pick<StoredBookmarkRow, 'url' | 'url_encrypted' | 'category' | 'category_encrypted'>>();

    return Promise.all(
      results.map(async (row) => ({
        url: (await this.encryption.decryptField(row.url_encrypted, row.url)) ?? '',
        category: await this.encryption.decryptField(row.category_encrypted, row.category),
      }))
    );
  }

  async search(userId: number, termGroups: string[][]): Promise<BookmarkSearchResult[]> {
    const blindQuery = await this.encryption.buildSearchQuery(termGroups);
    if (!blindQuery) return [];

    const { results } = await this.db
      .prepare(
        `SELECT b.*, bm25(bookmarks_fts) AS rank
         FROM bookmarks_fts
         JOIN bookmarks b ON b.id = bookmarks_fts.rowid
         WHERE bookmarks_fts MATCH ? AND b.user_id = ?
         ORDER BY rank
         LIMIT 50`
      )
      .bind(blindQuery, userId)
      .all<StoredBookmarkRow>();

    return Promise.all(results.map((row) => this.hydrateSearchResult(row)));
  }

  async markProcessed(id: number, title: string, bodyText: string, tags: string[]): Promise<void> {
    const row = await this.getStoredByIdOrThrow(id);
    const bookmark = await this.hydrateRow(row);
    const stored = await this.encryption.pack({
      url: bookmark.url,
      title,
      bodyText,
      tags,
      category: bookmark.category,
    });

    await this.db
      .prepare(
        `UPDATE bookmarks
         SET url = NULL,
             title = NULL,
             body_text = NULL,
             tags = NULL,
             category = NULL,
             url_encrypted = ?,
             title_encrypted = ?,
             body_text_encrypted = ?,
             tags_encrypted = ?,
             category_encrypted = ?,
             url_lookup = ?,
             category_lookup = ?,
             status = 'processed',
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        stored.urlEncrypted,
        stored.titleEncrypted,
        stored.bodyTextEncrypted,
        stored.tagsEncrypted,
        stored.categoryEncrypted,
        stored.urlLookup,
        stored.categoryLookup,
        id
      )
      .run();

    await this.replaceDerivedArtifacts(id, bookmark.user_id!, stored.searchDocument, stored.tagLookups);
  }

  async markFailed(id: number): Promise<void> {
    await this.db
      .prepare(`UPDATE bookmarks SET status = 'failed', updated_at = datetime('now') WHERE id = ?`)
      .bind(id)
      .run();
  }

  async updateCategory(id: number, category: string): Promise<void> {
    const row = await this.getStoredByIdOrThrow(id);
    const bookmark = await this.hydrateRow(row);
    const stored = await this.encryption.pack({
      url: bookmark.url,
      title: bookmark.title,
      bodyText: bookmark.body_text,
      tags: safeParseStoredTags(bookmark.tags),
      category,
    });

    await this.persistEncryptedBookmark(id, bookmark.user_id!, bookmark.status, stored);
  }

  async applyReorganization(userId: number, mapping: Array<{ from: string; to: string }>): Promise<void> {
    if (mapping.length === 0) return;

    const bySource = new Map(mapping.map((item) => [item.from, item.to]));
    const rows = await this.listAllStoredRowsByUser(userId);
    for (const row of rows) {
      const bookmark = await this.hydrateRow(row);
      if (!bookmark.category) continue;
      const target = bySource.get(bookmark.category);
      if (!target) continue;

      const stored = await this.encryption.pack({
        url: bookmark.url,
        title: bookmark.title,
        bodyText: bookmark.body_text,
        tags: safeParseStoredTags(bookmark.tags),
        category: target,
      });
      await this.persistEncryptedBookmark(bookmark.id, userId, bookmark.status, stored);
    }
  }

  async listForReorg(userId: number, limit: number): Promise<ReorgBookmarkRow[]> {
    const rows = await this.listAllStoredRowsByUser(userId, limit);
    const categorized = await Promise.all(rows.map((row) => this.hydrateReorgRow(row)));
    return categorized.filter((row) => Boolean(row.category));
  }

  async listByIds(userId: number, ids: number[]): Promise<ReorgBookmarkRow[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`${BASE_SELECT} WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...ids)
      .all<StoredBookmarkRow>();
    return Promise.all(results.map((row) => this.hydrateReorgRow(row)));
  }

  async applyBookmarkMoves(userId: number, moves: Array<{ id: number; category: string }>): Promise<void> {
    if (moves.length === 0) return;

    for (const move of moves) {
      const row = await this.db
        .prepare(`${BASE_SELECT} WHERE id = ? AND user_id = ?`)
        .bind(move.id, userId)
        .first<StoredBookmarkRow>();
      if (!row) continue;

      const bookmark = await this.hydrateRow(row);
      const stored = await this.encryption.pack({
        url: bookmark.url,
        title: bookmark.title,
        bodyText: bookmark.body_text,
        tags: safeParseStoredTags(bookmark.tags),
        category: move.category,
      });
      await this.persistEncryptedBookmark(move.id, userId, bookmark.status, stored);
    }
  }

  async listBookmarksByIds(userId: number, ids: number[]): Promise<BookmarkRow[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`${BASE_SELECT} WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...ids)
      .all<StoredBookmarkRow>();
    return Promise.all(results.map((row) => this.hydrateRow(row)));
  }

  async markEmbedded(id: number): Promise<void> {
    await this.db.prepare(`UPDATE bookmarks SET embedded_at = datetime('now') WHERE id = ?`).bind(id).run();
  }

  async listUnembeddedProcessed(limit: number): Promise<BookmarkRow[]> {
    const { results } = await this.db
      .prepare(
        `${BASE_SELECT}
         WHERE status = 'processed' AND embedded_at IS NULL AND user_id IS NOT NULL
         LIMIT ?`
      )
      .bind(limit)
      .all<StoredBookmarkRow>();
    return Promise.all(results.map((row) => this.hydrateRow(row)));
  }

  async updateByUrl(userId: number, url: string, fields: UpdateBookmarkFields): Promise<boolean> {
    const row = await this.findStoredByUrl(userId, url);
    if (!row) return false;

    const bookmark = await this.hydrateRow(row);
    const stored = await this.encryption.pack({
      url: bookmark.url,
      title: 'title' in fields ? (fields.title ?? null) : bookmark.title,
      bodyText: bookmark.body_text,
      tags: 'tags' in fields ? (fields.tags ?? []) : safeParseStoredTags(bookmark.tags),
      category: 'category' in fields ? (fields.category ?? null) : bookmark.category,
    });

    await this.persistEncryptedBookmark(row.id, userId, bookmark.status, stored);
    return true;
  }

  async deleteByUrl(userId: number, url: string): Promise<number | null> {
    const urlLookup = await this.encryption.buildUrlLookup(url);
    const deleted = await this.db
      .prepare(
        `DELETE FROM bookmarks
         WHERE user_id = ? AND (url_lookup = ? OR (url_lookup IS NULL AND url = ?))
         RETURNING id`
      )
      .bind(userId, urlLookup, url)
      .first<{ id: number }>();

    if (!deleted) return null;

    await this.db
      .batch([
        this.db.prepare(`DELETE FROM bookmark_tag_lookup WHERE bookmark_id = ?`).bind(deleted.id),
        this.db.prepare(`DELETE FROM bookmarks_fts WHERE rowid = ?`).bind(deleted.id),
      ])
      .catch(() => {});

    return deleted.id;
  }

  async backfillEncryption(limit: number): Promise<{ migrated: number; moreRemaining: boolean }> {
    const { results } = await this.db
      .prepare(
        `${BASE_SELECT}
         WHERE url_encrypted IS NULL AND url IS NOT NULL
         ORDER BY id
         LIMIT ?`
      )
      .bind(limit)
      .all<StoredBookmarkRow>();

    for (const row of results) {
      const bookmark = await this.hydrateRow(row);
      const stored = await this.encryption.pack({
        url: bookmark.url,
        title: bookmark.title,
        bodyText: bookmark.body_text,
        tags: safeParseStoredTags(bookmark.tags),
        category: bookmark.category,
      });
      await this.persistEncryptedBookmark(row.id, row.user_id, bookmark.status, stored, bookmark.embedded_at);
    }

    return { migrated: results.length, moreRemaining: results.length === limit };
  }

  private async findStoredByUrl(userId: number, url: string): Promise<StoredBookmarkRow | null> {
    const urlLookup = await this.encryption.buildUrlLookup(url);
    return this.db
      .prepare(
        `${BASE_SELECT}
         WHERE user_id = ? AND (url_lookup = ? OR (url_lookup IS NULL AND url = ?))
         LIMIT 1`
      )
      .bind(userId, urlLookup, url)
      .first<StoredBookmarkRow>();
  }

  private async getStoredByIdOrThrow(id: number): Promise<StoredBookmarkRow> {
    const row = await this.db.prepare(`${BASE_SELECT} WHERE id = ?`).bind(id).first<StoredBookmarkRow>();
    if (!row) {
      throw new Error(`Bookmark ${id} not found`);
    }
    return row;
  }

  private async listAllStoredRowsByUser(userId: number, limit?: number): Promise<StoredBookmarkRow[]> {
    const sql = `${BASE_SELECT} WHERE user_id = ? ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`;
    const prepared = this.db.prepare(sql);
    const { results } = limit
      ? await prepared.bind(userId, limit).all<StoredBookmarkRow>()
      : await prepared.bind(userId).all<StoredBookmarkRow>();
    return results;
  }

  private async persistEncryptedBookmark(
    id: number,
    userId: number | null,
    status: BookmarkRow['status'],
    stored: Awaited<ReturnType<BookmarkEncryptionService['pack']>>,
    embeddedAt?: string | null
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bookmarks
         SET url = NULL,
             title = NULL,
             body_text = NULL,
             tags = NULL,
             category = NULL,
             url_encrypted = ?,
             title_encrypted = ?,
             body_text_encrypted = ?,
             tags_encrypted = ?,
             category_encrypted = ?,
             url_lookup = ?,
             category_lookup = ?,
             status = ?,
             embedded_at = COALESCE(?, embedded_at),
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        stored.urlEncrypted,
        stored.titleEncrypted,
        stored.bodyTextEncrypted,
        stored.tagsEncrypted,
        stored.categoryEncrypted,
        stored.urlLookup,
        stored.categoryLookup,
        status,
        embeddedAt ?? null,
        id
      )
      .run();

    if (userId != null) {
      await this.replaceDerivedArtifacts(id, userId, stored.searchDocument, stored.tagLookups);
    }
  }

  private async replaceDerivedArtifacts(id: number, userId: number, searchDocument: string, tagLookups: string[]): Promise<void> {
    const statements = [
      this.db.prepare(`DELETE FROM bookmark_tag_lookup WHERE bookmark_id = ?`).bind(id),
      this.db.prepare(`DELETE FROM bookmarks_fts WHERE rowid = ?`).bind(id),
      this.db.prepare(`INSERT INTO bookmarks_fts (rowid, search_terms) VALUES (?, ?)`).bind(id, searchDocument),
      ...tagLookups.map((tagLookup) =>
        this.db
          .prepare(`INSERT INTO bookmark_tag_lookup (bookmark_id, user_id, tag_lookup) VALUES (?, ?, ?)`)
          .bind(id, userId, tagLookup)
      ),
    ];

    await this.db.batch(statements);
  }

  private async hydrateRow(row: StoredBookmarkRow): Promise<BookmarkRow> {
    const [url, title, bodyText, tags, category] = await Promise.all([
      this.encryption.decryptField(row.url_encrypted, row.url),
      this.encryption.decryptField(row.title_encrypted, row.title),
      this.encryption.decryptField(row.body_text_encrypted, row.body_text),
      this.encryption.decryptField(row.tags_encrypted, row.tags),
      this.encryption.decryptField(row.category_encrypted, row.category),
    ]);

    if (!url) {
      throw new Error(`Bookmark ${row.id} is missing a readable url`);
    }

    return {
      id: row.id,
      user_id: row.user_id,
      url,
      title,
      body_text: bodyText,
      tags,
      category,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      embedded_at: row.embedded_at,
    };
  }

  private async hydrateReorgRow(row: StoredBookmarkRow): Promise<ReorgBookmarkRow> {
    const bookmark = await this.hydrateRow(row);
    return {
      id: bookmark.id,
      url: bookmark.url,
      title: bookmark.title,
      category: bookmark.category,
    };
  }

  private async hydrateSearchResult(row: StoredBookmarkRow): Promise<BookmarkSearchResult> {
    const bookmark = await this.hydrateRow(row);
    return { ...bookmark, rank: row.rank ?? 0 };
  }
}

const BASE_SELECT = `
  SELECT
    id, user_id, url, title, body_text, tags, category,
    url_encrypted, title_encrypted, body_text_encrypted, tags_encrypted, category_encrypted,
    url_lookup, category_lookup, status, created_at, updated_at, embedded_at
  FROM bookmarks
`;

function safeParseStoredTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}
