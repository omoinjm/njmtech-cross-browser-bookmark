import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import { buildEmbeddingInput } from '../../services/embedding-generator';

export const admin = new Hono<AppEnv>();

// A maintenance sweep across every user's backlog, not a per-user route —
// gated behind requireSession (any logged-in account can trigger it) rather
// than keeping the legacy API_TOKEN alive for this one route. Triggering a
// global, idempotent embedding backfill exposes nothing about other users'
// data, so this is intentionally not scoped to the caller's own bookmarks.
admin.use('*', requireSession);

// One Workers AI embedding call per bookmark — keeps a single request
// bounded. Safely re-runnable: call again while `moreRemaining` is true.
const BACKFILL_BATCH_SIZE = 50;

/**
 * POST /api/v1/admin/backfill-embeddings
 * One-off, manually-triggered: generates and stores a semantic-search
 * embedding (see services/embedding-generator.ts, services/semantic-index.ts)
 * for every already-processed, owned bookmark that doesn't have one yet
 * (embedded_at IS NULL) — i.e. anything created before semantic search
 * existed. New bookmarks get embedded automatically by the ingestion
 * pipeline going forward; this only ever needs to run once per pre-existing
 * backlog, though it's safe to call again (it always re-queries for
 * whatever's still unembedded).
 */
admin.post('/backfill-embeddings', async (c) => {
  const { repository, embeddingGenerator, semanticIndex } = c.get('deps');
  const candidates = await repository.listUnembeddedProcessed(BACKFILL_BATCH_SIZE);

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
      console.error(`[admin/backfill-embeddings] failed for bookmark ${bookmark.id}:`, err);
      failed++;
    }
  }

  return c.json({
    embedded,
    failed,
    processedThisBatch: candidates.length,
    moreRemaining: candidates.length === BACKFILL_BATCH_SIZE,
  });
});
