import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './env';
import type { AppEnv } from './http-context';
import { buildDependencies } from './container';
import { v1 } from './routes/v1';
import { runEmbeddingBackfill } from './services/embedding-backfill';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

// Personal single-user tool talking to itself from an extension background
// worker — permissive CORS is fine here. Tighten `origin` if this ever gets
// a hosted frontend with a fixed domain.
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

// Composition root: build the concrete repository/scraper/tagger/pipeline
// for this request's bindings once, and hand routes only the interfaces via
// `c.get('deps')` — see container.ts.
app.use('*', async (c, next) => {
  c.set('deps', buildDependencies(c.env));
  await next();
});

app.get('/', (c) => c.json({ ok: true, service: 'bookmark-sync-engine', api: '/api/v1' }));

app.route('/api/v1', v1);

// HTTPException (e.g. bearerAuth's 401/400) already carries its own correct,
// safe response — pass it through untouched. Anything else is unexpected:
// log it server-side and give the client only a generic message, never a
// stack trace or error detail.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error('[unhandled]', err);
  return c.text('Internal Server Error', 500);
});

export default {
  fetch: app.fetch,

  // Cloudflare Cron Trigger (see wrangler.toml's [triggers]) — catches
  // anything the live per-bookmark embedding call missed (a transient
  // failure) plus any backlog from before semantic search existed, without
  // needing someone to remember to call POST /api/v1/admin/backfill-embeddings
  // by hand. See services/embedding-backfill.ts.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const deps = buildDependencies(env);
    ctx.waitUntil(
      runEmbeddingBackfill(deps).then(
        (result) => console.log('[scheduled] embedding backfill:', result),
        (err) => console.error('[scheduled] embedding backfill failed:', err)
      )
    );
  },
};
