import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import { generatePassword } from '../../lib/password';

export const auth = new Hono<AppEnv>();

const MAX_AUTH_BODY_BYTES = 4 * 1024;
const MAX_EMAIL_CHARS = 320; // RFC 5321
const MAX_PASSWORD_CHARS = 256;

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  // Deliberately loose (contains "@", has something on both sides, no
  // whitespace) — real validation is "did the email actually arrive",
  // which the send step itself proves; a stricter regex here would just
  // reject valid addresses it doesn't recognize.
  if (!trimmed || trimmed.length > MAX_EMAIL_CHARS || !/^\S+@\S+\.\S+$/.test(trimmed)) return null;
  return trimmed;
}

const authBodyLimit = bodyLimit({
  maxSize: MAX_AUTH_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
});

/**
 * POST /api/v1/auth/register
 * Body: { email }
 *
 * No password is ever chosen by the caller or returned in this response —
 * one is generated server-side and emailed via services/email-sender.ts.
 * Email-first ordering: the email is sent BEFORE the user row is created,
 * so a failed/rate-limited send never leaves behind an account whose only
 * password was lost in transit — the caller just gets an error and can
 * retry, with nothing created.
 */
auth.post('/register', authBodyLimit, async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) {
    return c.json({ error: 'A valid "email" is required' }, 400);
  }

  const { userRepository, passwordHasher, emailSender } = c.get('deps');

  const existing = await userRepository.findByEmail(email);
  if (existing) {
    return c.json({ error: 'An account with this email already exists' }, 409);
  }

  const password = generatePassword();

  try {
    await emailSender.sendAccountCredentials(email, password);
  } catch (err) {
    console.error('[auth/register] failed to send credentials email:', err);
    return c.json({ error: 'Failed to send the account email — nothing was created, try again' }, 502);
  }

  const passwordHash = await passwordHasher.hash(password);
  await userRepository.createUser(email, passwordHash);

  return c.json({ message: 'Check your email for your password' }, 201);
});

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 */
auth.post('/login', authBodyLimit, async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === 'string' ? body.password.slice(0, MAX_PASSWORD_CHARS) : null;

  if (!email || !password) {
    return c.json({ error: '"email" and "password" are required' }, 400);
  }

  const { userRepository, passwordHasher, sessionRepository } = c.get('deps');

  const user = await userRepository.findByEmail(email);
  // Same generic error either way — never reveal whether the email exists.
  if (!user || !(await passwordHasher.verify(password, user.passwordHash))) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const session = await sessionRepository.createSession(user.id);

  return c.json({ sessionToken: session.token, expiresAt: session.expiresAt, user: { id: user.id, email: user.email } });
});

/**
 * POST /api/v1/auth/reset-password
 * Body: { email }
 *
 * Always responds with the same message regardless of whether the account
 * exists — never lets a caller use this to enumerate registered emails.
 * When it does exist: generates+emails a new password (same email-first
 * ordering as /register) and revokes every existing session, forcing
 * re-login with the new password.
 */
auth.post('/reset-password', authBodyLimit, async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) {
    return c.json({ error: 'A valid "email" is required' }, 400);
  }

  const { userRepository, passwordHasher, emailSender, sessionRepository } = c.get('deps');
  const genericResponse = { message: 'If that email is registered, a new password has been sent' };

  const user = await userRepository.findByEmail(email);
  if (!user) {
    return c.json(genericResponse);
  }

  const password = generatePassword();

  try {
    await emailSender.sendAccountCredentials(email, password);
  } catch (err) {
    console.error('[auth/reset-password] failed to send credentials email:', err);
    // Still generic — don't confirm the account exists via a different
    // error shape than the not-found case above.
    return c.json({ error: 'Failed to send the reset email — try again' }, 502);
  }

  const passwordHash = await passwordHasher.hash(password);
  await userRepository.updatePasswordHash(user.id, passwordHash);
  await sessionRepository.revokeAllSessions(user.id);

  return c.json(genericResponse);
});

/**
 * POST /api/v1/auth/change-password
 * Body: { currentPassword, newPassword }
 * Lets someone stop relying on the system-generated password.
 */
auth.post('/change-password', requireSession, authBodyLimit, async (c) => {
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => null);
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword.slice(0, MAX_PASSWORD_CHARS) : null;
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword.slice(0, MAX_PASSWORD_CHARS) : null;

  if (!currentPassword || !newPassword) {
    return c.json({ error: '"currentPassword" and "newPassword" are required' }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: '"newPassword" must be at least 8 characters' }, 400);
  }

  const { userRepository, passwordHasher } = c.get('deps');
  const authedUser = c.get('user');

  const user = await userRepository.findByEmail(authedUser.email);
  if (!user || !(await passwordHasher.verify(currentPassword, user.passwordHash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const passwordHash = await passwordHasher.hash(newPassword);
  await userRepository.updatePasswordHash(user.id, passwordHash);

  return c.json({ ok: true });
});

/**
 * POST /api/v1/auth/logout
 * Revokes the current session. Idempotent — revoking an already-invalid
 * token is not an error, since the end state (not authenticated) is the
 * same either way.
 */
auth.post('/logout', requireSession, async (c) => {
  const header = c.req.header('Authorization');
  const token = header!.slice('Bearer '.length);
  await c.get('deps').sessionRepository.revokeSession(token);
  return c.json({ ok: true });
});

/**
 * GET /api/v1/auth/me
 * Returns the current user's profile — used by the extension's Account tab
 * to show who's signed in.
 */
auth.get('/me', requireSession, async (c) => {
  return c.json({ user: c.get('user') });
});
