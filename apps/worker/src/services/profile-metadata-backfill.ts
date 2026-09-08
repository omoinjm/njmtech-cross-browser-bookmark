import type { Dependencies } from '../container';

export interface ProfileMetadataBackfillResult {
  updated: number;
  skipped: number;
  processedThisBatch: number;
  nextOffset: number;
  moreRemaining: boolean;
}

// Kept small since each row needs a Vectorize read (getVectorValues) AND a
// write (upsert) — twice the round trips of the plain embedding backfill's
// one-write-per-row loop.
export const PROFILE_METADATA_BACKFILL_BATCH_SIZE = 50;

/**
 * One-time migration cleanup: re-upserts an existing Vectorize vector (one
 * embedded before migrations/0005_add_profiles.sql existed, so its metadata
 * only has `user_id`) with `profile_id` added, using the vector's own
 * already-computed values — no re-embedding needed. Without this, a search
 * filtered by both user_id AND profile_id (see semantic-index.ts) would
 * never match a legacy vector at all, since Vectorize's metadata filter
 * requires every filtered field to be present.
 *
 * Deliberately NOT wired into the scheduled cron (unlike
 * services/embedding-backfill.ts) — this has no ongoing steady-state work
 * once every legacy vector has been re-upserted once. Call POST
 * /admin/backfill-profile-metadata repeatedly (advancing `offset` by each
 * response's `nextOffset`) until `moreRemaining` is false.
 */
export async function runProfileMetadataBackfillBatch(
  deps: Dependencies,
  offset: number,
  batchSize: number = PROFILE_METADATA_BACKFILL_BATCH_SIZE
): Promise<ProfileMetadataBackfillResult> {
  const { repository, semanticIndex } = deps;
  const candidates = await repository.listEmbeddedWithProfile(batchSize, offset);

  const vectorValues = await semanticIndex.getVectorValues(candidates.map((b) => b.id));

  let updated = 0;
  let skipped = 0;

  for (const bookmark of candidates) {
    const values = vectorValues.get(bookmark.id);
    // No stored vector for this id (e.g. cleaned up by a delete that raced
    // with this sweep) — nothing to re-upsert.
    if (!values) {
      skipped++;
      continue;
    }

    try {
      // user_id/profile_id are guaranteed non-null by listEmbeddedWithProfile's
      // WHERE clause (embedded_at IS NOT NULL AND profile_id IS NOT NULL —
      // and every row with a profile_id also has a user_id).
      await semanticIndex.upsert(bookmark.id, bookmark.user_id!, bookmark.profile_id!, values);
      updated++;
    } catch (err) {
      console.error(`[profile-metadata-backfill] failed for bookmark ${bookmark.id}:`, err);
      skipped++;
    }
  }

  return {
    updated,
    skipped,
    processedThisBatch: candidates.length,
    nextOffset: offset + candidates.length,
    moreRemaining: candidates.length === batchSize,
  };
}
