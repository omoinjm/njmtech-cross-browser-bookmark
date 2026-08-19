import { bearerAuth } from 'hono/bearer-auth';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../http-context';

/**
 * Requires `Authorization: Bearer <API_TOKEN>`, compared in constant time
 * (delegated to hono/bearer-auth). The token itself lives only in the
 * Cloudflare secret store (`wrangler secret put API_TOKEN`) — never in
 * wrangler.toml or source. If the secret isn't configured, every request
 * fails closed (401), not open.
 */
export const requireApiToken: MiddlewareHandler<AppEnv> = (c, next) =>
  bearerAuth<AppEnv>({ token: c.env.API_TOKEN })(c, next);
