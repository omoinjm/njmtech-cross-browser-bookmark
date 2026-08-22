/**
 * Stores/queries one embedding per bookmark for semantic search. Route/
 * pipeline code depends on this interface, not on Vectorize directly — a
 * different vector store just means a new implementation.
 */
export interface SemanticIndex {
  upsert(bookmarkId: number, vector: number[]): Promise<void>;
  delete(bookmarkId: number): Promise<void>;
  /** Nearest neighbors to `vector`, best match first. */
  query(vector: number[], topK: number): Promise<Array<{ id: number; score: number }>>;
}

export class VectorizeSemanticIndex implements SemanticIndex {
  constructor(private readonly index: VectorizeIndex) {}

  async upsert(bookmarkId: number, vector: number[]): Promise<void> {
    // Vectorize ids are strings; the bookmark's own D1 row id (stringified)
    // is the natural key — an upsert with the same id just overwrites, so
    // this is safe to call again for the same bookmark.
    await this.index.upsert([{ id: String(bookmarkId), values: vector }]);
  }

  async delete(bookmarkId: number): Promise<void> {
    await this.index.deleteByIds([String(bookmarkId)]);
  }

  async query(vector: number[], topK: number): Promise<Array<{ id: number; score: number }>> {
    const result = await this.index.query(vector, { topK });
    return result.matches
      .map((match) => ({ id: Number(match.id), score: match.score }))
      .filter((match) => Number.isInteger(match.id));
  }
}
