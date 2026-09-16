import type { Dependencies } from '../container';

export interface BookmarkSearchReindexResult {
  reindexed: number;
  moreRemaining: boolean;
}

export const BOOKMARK_SEARCH_REINDEX_BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 20;

export async function runBookmarkSearchReindexBatch(
  deps: Dependencies,
  batchSize: number = BOOKMARK_SEARCH_REINDEX_BATCH_SIZE
): Promise<BookmarkSearchReindexResult> {
  return deps.repository.reindexSearchDocuments(batchSize);
}

export async function runBookmarkSearchReindex(
  deps: Dependencies,
  batchSize: number = BOOKMARK_SEARCH_REINDEX_BATCH_SIZE
): Promise<BookmarkSearchReindexResult> {
  let reindexed = 0;
  let moreRemaining = false;

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const batch = await runBookmarkSearchReindexBatch(deps, batchSize);
    reindexed += batch.reindexed;
    moreRemaining = batch.moreRemaining;

    if (!batch.moreRemaining || batch.reindexed === 0) break;
  }

  return { reindexed, moreRemaining };
}
