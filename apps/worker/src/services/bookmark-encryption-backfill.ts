import type { Dependencies } from '../container';

export interface BookmarkEncryptionBackfillResult {
  migrated: number;
  moreRemaining: boolean;
}

export const BOOKMARK_ENCRYPTION_BACKFILL_BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;

export async function runBookmarkEncryptionBackfillBatch(
  deps: Dependencies,
  batchSize: number = BOOKMARK_ENCRYPTION_BACKFILL_BATCH_SIZE
): Promise<BookmarkEncryptionBackfillResult> {
  return deps.repository.backfillEncryption(batchSize);
}

export async function runBookmarkEncryptionBackfill(
  deps: Dependencies,
  batchSize: number = BOOKMARK_ENCRYPTION_BACKFILL_BATCH_SIZE
): Promise<BookmarkEncryptionBackfillResult> {
  let migrated = 0;
  let moreRemaining = false;

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const batch = await runBookmarkEncryptionBackfillBatch(deps, batchSize);
    migrated += batch.migrated;
    moreRemaining = batch.moreRemaining;

    if (!batch.moreRemaining || batch.migrated === 0) break;
  }

  return { migrated, moreRemaining };
}
