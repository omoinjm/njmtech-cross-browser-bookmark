/**
 * Turns text into a vector for semantic (meaning-based) search, as opposed
 * to the keyword-based FTS search in bookmarks_fts. Route/pipeline code
 * depends on this interface, not on Workers AI directly — a different
 * embedding model/provider just means a new implementation (as long as its
 * output dimension matches the Vectorize index's, which was created for
 * this specific model — see wrangler.toml).
 */
export interface EmbeddingGenerator {
  embed(text: string): Promise<number[]>;
}

// 768-dimensional output — the Vectorize index (bookmarks-embeddings) was
// created with dimensions=768 to match. Changing this model means
// recreating the index (and re-embedding everything), not just swapping a
// constant.
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

// bge-base-en-v1.5 has a 512-token context window (~2000 English chars is a
// safe stay-under-it estimate) — truncating defensively here rather than
// trusting Workers AI to truncate the same way keeps embedding input
// deterministic regardless of provider behavior.
export const MAX_EMBEDDING_INPUT_CHARS = 2000;

/** Builds the text embedded for a bookmark — shared by the ingestion pipeline and the backfill route, so both index identically. */
export function buildEmbeddingInput(title: string | null, bodyText: string | null): string {
  return `${title || ''}\n\n${bodyText || ''}`.trim().slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

export class WorkersAiEmbeddingGenerator implements EmbeddingGenerator {
  constructor(private readonly ai: Ai) {}

  async embed(text: string): Promise<number[]> {
    const response = await this.ai.run(EMBEDDING_MODEL, { text: [text] });
    const vector = (response as { data?: number[][] })?.data?.[0];
    if (!vector) {
      throw new Error('Embedding model returned no vector');
    }
    return vector;
  }
}
