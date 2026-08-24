import { Hono } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
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
