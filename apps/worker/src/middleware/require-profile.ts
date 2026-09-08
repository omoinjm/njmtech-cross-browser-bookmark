import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../http-context';

/**
 * Resolves which profile a request operates within, from an `X-Profile-Id`
 * header — chosen over a query param since "which profile" is a
 * cross-cutting concern like `Authorization`, not part of any one endpoint's
 * own query shape. Must run after requireSession (reads `c.get('user')`).
 *
 * - Header present: re-validates it belongs to the calling user (same
 *   re-check-ownership pattern as categories.ts's /reorganize with a
 *   client-supplied bookmarkId) — 403 if it doesn't, rather than silently
 *   falling back, so a stale/foreign id is never mistaken for consent to
 *   operate in the caller's own default profile.
 * - Header absent: lazily resolves (creating "Personal" if needed) the
 *   caller's default profile — this is what keeps an extension build that
 *   predates profiles working unmodified against "Personal" after this
 *   ships (see rollout notes in the profiles plan).
 *
 * Sets `c.set('profile', ...)` for downstream handlers.
 */
export const requireProfile = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  const header = c.req.header('X-Profile-Id');

  if (header) {
    const profileId = Number(header);
    const profile = Number.isInteger(profileId)
      ? await c.get('deps').profileRepository.findById(user.id, profileId)
      : null;

    if (!profile) {
      throw new HTTPException(403, { message: 'Unknown or inaccessible profile' });
    }

    c.set('profile', profile);
    await next();
    return;
  }

  const profile = await c.get('deps').profileRepository.getOrCreateDefault(user.id);
  c.set('profile', profile);
  await next();
});
