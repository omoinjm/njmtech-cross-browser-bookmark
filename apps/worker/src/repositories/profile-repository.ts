import type { ProfileRow } from '../env';

/**
 * CRUD for the set of profiles a user has (e.g. "Personal", "Work") — not
 * to be confused with scoping bookmarks BY a profile, which is
 * BookmarkRepository's job. Every method takes a `userId` and enforces it
 * in its SQL, same hard-boundary treatment as BookmarkRepository — a
 * profile id from one user must never be readable/writable by another.
 */
export interface ProfileRepository {
  listByUser(userId: number): Promise<ProfileRow[]>;
  findById(userId: number, profileId: number): Promise<ProfileRow | null>;
  /** Returns the oldest (first-created) profile, creating a "Personal" one if the user has none yet. */
  getOrCreateDefault(userId: number): Promise<ProfileRow>;
  /** Throws (D1's underlying SQLITE_CONSTRAINT error) on a UNIQUE(user_id, name) violation — the route maps that to 409. */
  create(userId: number, name: string): Promise<ProfileRow>;
  /** Returns false when no profile with this id exists for this user — the route turns that into a 404. */
  rename(userId: number, profileId: number, name: string): Promise<boolean>;
  countBookmarks(userId: number, profileId: number): Promise<number>;
  /** Returns false when no profile with this id exists for this user. */
  delete(userId: number, profileId: number): Promise<boolean>;
}

export class D1ProfileRepository implements ProfileRepository {
  constructor(private readonly db: D1Database) {}

  async listByUser(userId: number): Promise<ProfileRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC`)
      .bind(userId)
      .all<ProfileRow>();
    return results;
  }

  async findById(userId: number, profileId: number): Promise<ProfileRow | null> {
    return this.db
      .prepare(`SELECT * FROM profiles WHERE id = ? AND user_id = ?`)
      .bind(profileId, userId)
      .first<ProfileRow>();
  }

  async getOrCreateDefault(userId: number): Promise<ProfileRow> {
    const existing = await this.db
      .prepare(`SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`)
      .bind(userId)
      .first<ProfileRow>();
    if (existing) return existing;

    return this.create(userId, 'Personal');
  }

  async create(userId: number, name: string): Promise<ProfileRow> {
    const insert = await this.db
      .prepare(`INSERT INTO profiles (user_id, name) VALUES (?, ?)`)
      .bind(userId, name)
      .run();

    return { id: insert.meta.last_row_id, user_id: userId, name, created_at: new Date().toISOString() };
  }

  async rename(userId: number, profileId: number, name: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE profiles SET name = ? WHERE id = ? AND user_id = ?`)
      .bind(name, profileId, userId)
      .run();
    return result.meta.changes > 0;
  }

  async countBookmarks(userId: number, profileId: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM bookmarks WHERE user_id = ? AND profile_id = ?`)
      .bind(userId, profileId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async delete(userId: number, profileId: number): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM profiles WHERE id = ? AND user_id = ?`)
      .bind(profileId, userId)
      .run();
    return result.meta.changes > 0;
  }
}
