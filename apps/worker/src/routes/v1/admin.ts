import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import { runBookmarkEncryptionBackfillBatch } from '../../services/bookmark-encryption-backfill';
import { runBookmarkSearchReindexBatch } from '../../services/bookmark-search-reindex';
import { runEmbeddingBackfillBatch } from '../../services/embedding-backfill';

export const admin = new Hono<AppEnv>();

// A maintenance sweep across every user's backlog, not a per-user route —
// gated behind requireSession (any logged-in account can trigger it) rather
// than keeping the legacy API_TOKEN alive for this one route. Triggering a
// global, idempotent embedding backfill exposes nothing about other users'
// data, so this is intentionally not scoped to the caller's own bookmarks.
admin.use('*', requireSession);

/**
 * POST /api/v1/admin/backfill-embeddings
 * Manual, on-demand escape hatch for the same backfill a scheduled cron
 * trigger now runs automatically every 15 minutes (see the `scheduled`
 * handler in src/index.ts and services/embedding-backfill.ts) — useful for
 * forcing an immediate run instead of waiting for the next tick. One batch
 * per call; safe to call again while `moreRemaining` is true.
 */
admin.post('/backfill-embeddings', async (c) => {
  const result = await runEmbeddingBackfillBatch(c.get('deps'));
  return c.json(result);
});

/**
 * POST /api/v1/admin/backfill-bookmark-encryption
 * Encrypts one batch of legacy plaintext bookmark rows in place, rebuilding
 * exact-match and search artifacts as it goes. Safe to call repeatedly until
 * `moreRemaining` is false.
 */
admin.post('/backfill-bookmark-encryption', async (c) => {
  const result = await runBookmarkEncryptionBackfillBatch(c.get('deps'));
  return c.json(result);
});

/**
 * POST /api/v1/admin/reindex-bookmark-search
 * Rebuilds one batch of missing bookmarks_fts rows from each bookmark's
 * current (encrypted-or-legacy) content, without touching the source
 * columns. Safe to call repeatedly until `moreRemaining` is false — for
 * repairing/rebuilding the search index in place, e.g. after bookmarks_fts
 * was dropped and recreated.
 */
admin.post('/reindex-bookmark-search', async (c) => {
  const result = await runBookmarkSearchReindexBatch(c.get('deps'));
  return c.json(result);
});

/**
 * POST /api/v1/admin/reindex-vectorize-metadata
 * One-off fix for vectors upserted before a Vectorize metadata index existed
 * (see create-metadata-index) — re-upserts every embedded bookmark's
 * existing vector unchanged so it's actually covered by the metadata filter
 * semantic search relies on. Safe to call more than once (idempotent).
 */
admin.post('/reindex-vectorize-metadata', async (c) => {
  const { repository, semanticIndex } = c.get('deps');
  const ids = await repository.listEmbeddedBookmarkIds();
  const reindexed = await semanticIndex.reindexMetadata(ids);
  return c.json({ candidates: ids.length, reindexed });
});
