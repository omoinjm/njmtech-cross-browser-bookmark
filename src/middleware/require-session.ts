import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../http-context';

/**
 * Requires `Authorization: Bearer <session token>`, validated against the
 * `sessions` table (see repositories/session-repository.ts) rather than a
 * single shared secret — this is what replaces require-api-token.ts once
 * the multi-tenant rollout cuts over (see the redesign plan's Phase 5).
 * Sets `c.set('user', ...)` for downstream handlers.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!token) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }

  const user = await c.get('deps').sessionRepository.validateSession(token);
  if (!user) {
    throw new HTTPException(401, { message: 'Invalid or expired session' });
  }

  c.set('user', user);
  await next();
});
