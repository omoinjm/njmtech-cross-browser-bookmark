/**
 * Stores/queries one embedding per bookmark for semantic search. Route/
 * pipeline code depends on this interface, not on Vectorize directly — a
 * different vector store just means a new implementation.
 *
 * `userId` AND `profileId` are both stored as metadata on every vector and
 * enforced as a query filter — a hard multi-tenant AND cross-profile
 * isolation boundary, same as every BookmarkRepository method: a search must
 * never surface a match belonging to a different user OR a different
 * profile of the same user, even transiently before the D1 hydration step
 * in search.ts.
 */
export interface SemanticIndex {
  upsert(bookmarkId: number, userId: number, profileId: number, vector: number[]): Promise<void>;
  delete(bookmarkId: number): Promise<void>;
  /** Nearest neighbors to `vector` scoped to `userId` + `profileId`, best match first. */
  query(vector: number[], userId: number, profileId: number, topK: number): Promise<Array<{ id: number; score: number }>>;
  /**
   * Fetches already-stored vector values for the given bookmark ids, keyed
   * by id — used only by the one-time POST /admin/backfill-profile-metadata
   * sweep to re-upsert a legacy vector (embedded before profiles existed)
   * with `profile_id` added to its metadata, without needing to re-run the
   * (paid) embedding model over the source text again. An id with no stored
   * vector is simply absent from the returned map.
   */
  getVectorValues(bookmarkIds: number[]): Promise<Map<number, number[]>>;
}

export class VectorizeSemanticIndex implements SemanticIndex {
  constructor(private readonly index: VectorizeIndex) {}

  async upsert(bookmarkId: number, userId: number, profileId: number, vector: number[]): Promise<void> {
    // Vectorize ids are strings; the bookmark's own D1 row id (stringified)
    // is the natural key — an upsert with the same id just overwrites, so
    // this is safe to call again for the same bookmark.
    await this.index.upsert([
      { id: String(bookmarkId), values: vector, metadata: { user_id: userId, profile_id: profileId } },
    ]);
  }

  async delete(bookmarkId: number): Promise<void> {
    await this.index.deleteByIds([String(bookmarkId)]);
  }

  async query(vector: number[], userId: number, profileId: number, topK: number): Promise<Array<{ id: number; score: number }>> {
    const result = await this.index.query(vector, { topK, filter: { user_id: userId, profile_id: profileId } });
    return result.matches
      .map((match) => ({ id: Number(match.id), score: match.score }))
      .filter((match) => Number.isInteger(match.id));
  }

  async getVectorValues(bookmarkIds: number[]): Promise<Map<number, number[]>> {
    if (bookmarkIds.length === 0) return new Map();

    const vectors = await this.index.getByIds(bookmarkIds.map(String));
    return new Map(vectors.map((v) => [Number(v.id), Array.from(v.values)]));
  }
}
