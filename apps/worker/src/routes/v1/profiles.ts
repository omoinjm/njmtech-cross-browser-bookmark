import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import { MAX_PROFILE_NAME_CHARS } from '../../lib/validation';

export const profiles = new Hono<AppEnv>();

// Gated on requireSession only, not requireProfile — these routes manage the
// *set* of a user's profiles, they aren't themselves scoped to one.
profiles.use('*', requireSession);

const MAX_BODY_BYTES = 2 * 1024;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

function parseProfileName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim().slice(0, MAX_PROFILE_NAME_CHARS) : '';
  return name.length > 0 ? name : null;
}

/**
 * GET /api/v1/profiles
 * Lists the caller's profiles, oldest first (the oldest is the implicit
 * default — see ProfileRepository.getOrCreateDefault). Calls
 * getOrCreateDefault first when the list comes back empty so the extension's
 * profile switcher never renders zero options, even for a brand-new account
 * that hasn't made any other API call yet.
 */
profiles.get('/', async (c) => {
  const user = c.get('user');
  const { profileRepository } = c.get('deps');

  let list = await profileRepository.listByUser(user.id);
  if (list.length === 0) {
    await profileRepository.getOrCreateDefault(user.id);
    list = await profileRepository.listByUser(user.id);
  }

  return c.json({ profiles: list });
});

/**
 * POST /api/v1/profiles
 * Body: { name: string }
 */
profiles.post(
  '/',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  async (c) => {
    const payload = await c.req.json<{ name?: string }>().catch(() => null);
    const name = parseProfileName(payload?.name);
    if (!name) {
      return c.json({ error: 'A non-empty "name" is required' }, 400);
    }

    const user = c.get('user');
    const { profileRepository } = c.get('deps');

    try {
      const profile = await profileRepository.create(user.id, name);
      return c.json({ profile }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'A profile with this name already exists' }, 409);
      }
      throw err;
    }
  }
);

/**
 * PATCH /api/v1/profiles/:id
 * Body: { name: string }
 */
profiles.patch(
  '/:id',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) {
      return c.json({ error: 'Invalid id' }, 400);
    }

    const payload = await c.req.json<{ name?: string }>().catch(() => null);
    const name = parseProfileName(payload?.name);
    if (!name) {
      return c.json({ error: 'A non-empty "name" is required' }, 400);
    }

    const user = c.get('user');
    const { profileRepository } = c.get('deps');

    try {
      const renamed = await profileRepository.rename(user.id, id, name);
      if (!renamed) {
        return c.json({ error: 'Not found' }, 404);
      }
      return c.json({ ok: true });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'A profile with this name already exists' }, 409);
      }
      throw err;
    }
  }
);

/**
 * DELETE /api/v1/profiles/:id
 * Blocked (409) while the profile still has bookmarks — the caller must
 * empty it first, since cascade-deleting a whole profile's bookmarks is a
 * much bigger blast radius than any other delete in this API. Also blocked
 * (400) if it's the user's only profile — profiles are meant to always have
 * at least one, matching the "Personal" auto-seed guarantee.
 */
profiles.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Invalid id' }, 400);
  }

  const user = c.get('user');
  const { profileRepository } = c.get('deps');

  const existing = await profileRepository.findById(user.id, id);
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  const allProfiles = await profileRepository.listByUser(user.id);
  if (allProfiles.length <= 1) {
    return c.json({ error: 'Cannot delete your only profile' }, 400);
  }

  const bookmarkCount = await profileRepository.countBookmarks(user.id, id);
  if (bookmarkCount > 0) {
    return c.json({ error: 'Profile is not empty', bookmarkCount }, 409);
  }

  await profileRepository.delete(user.id, id);
  return c.json({ ok: true });
});
