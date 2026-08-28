import type { Dependencies } from '../container';
import { buildEmbeddingInput } from './embedding-generator';

export interface BackfillResult {
  embedded: number;
  failed: number;
  processedThisBatch: number;
  moreRemaining: boolean;
}

// One Workers AI embedding call per bookmark — keeps a single batch's work
// bounded, whether it's driven by the manual admin route or the scheduled
// cron trigger below.
export const BACKFILL_BATCH_SIZE = 50;

/**
 * Embeds and indexes one batch of already-processed, owned bookmarks that
 * don't have a semantic-search embedding yet (embedded_at IS NULL) — i.e.
 * anything created before semantic search existed, or whose live embedding
 * call (BookmarkIngestionPipeline.indexForSemanticSearch) failed at
 * ingestion time. Safe to call repeatedly — each call re-queries for
 * whatever's still unembedded, so a failure here just means it comes back
 * in the next batch. See runEmbeddingBackfill below for draining more than
 * one batch in a single call.
 */
export async function runEmbeddingBackfillBatch(deps: Dependencies, batchSize: number = BACKFILL_BATCH_SIZE): Promise<BackfillResult> {
  const { repository, embeddingGenerator, semanticIndex } = deps;
  const candidates = await repository.listUnembeddedProcessed(batchSize);

  let embedded = 0;
  let failed = 0;

  for (const bookmark of candidates) {
    try {
      const vector = await embeddingGenerator.embed(buildEmbeddingInput(bookmark.title, bookmark.body_text));
      // listUnembeddedProcessed's WHERE clause already excludes user_id IS
      // NULL rows, so this is always populated here.
      await semanticIndex.upsert(bookmark.id, bookmark.user_id!, vector);
      await repository.markEmbedded(bookmark.id);
      embedded++;
    } catch (err) {
      console.error(`[embedding-backfill] failed for bookmark ${bookmark.id}:`, err);
      failed++;
    }
  }

  return {
    embedded,
    failed,
    processedThisBatch: candidates.length,
    moreRemaining: candidates.length === batchSize,
  };
}

// Bounds how many batches one scheduled run will drain — an unattended cron
// tick has no caller waiting to see moreRemaining and call again, so it
// needs its own stopping point (up to 1,000 bookmarks per tick at the
// default batch size) rather than looping forever.
const MAX_BATCHES_PER_RUN = 20;

/**
 * Drains as much of the backlog as it can in one call — used by the
 * scheduled cron trigger (see the `scheduled` handler in src/index.ts).
 * Stops early if a whole batch made zero progress (every candidate failed):
 * a failure never sets embedded_at, so those exact rows would just come
 * back on the next call — better to leave them for the next scheduled tick
 * than burn the rest of this run's batch budget retrying the same ones.
 */
export async function runEmbeddingBackfill(deps: Dependencies, batchSize: number = BACKFILL_BATCH_SIZE): Promise<BackfillResult> {
  const totals: BackfillResult = { embedded: 0, failed: 0, processedThisBatch: 0, moreRemaining: false };

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const batch = await runEmbeddingBackfillBatch(deps, batchSize);
    totals.embedded += batch.embedded;
    totals.failed += batch.failed;
    totals.processedThisBatch += batch.processedThisBatch;
    totals.moreRemaining = batch.moreRemaining;

    if (batch.embedded === 0) break;
  }

  return totals;
}
