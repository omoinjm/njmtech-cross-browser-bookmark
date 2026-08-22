import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../http-context';
import { requireSession } from '../../middleware/require-session';
import type { OAuthProvider } from '../../services/oauth/oauth-provider';
import type { OAuthProviderName } from '../../env';

export const auth = new Hono<AppEnv>();

interface CallbackBody {
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
}

/**
 * Shared by POST /auth/google and POST /auth/microsoft. Exchanges the
 * authorization code the extension got from
 * `browser.identity.launchWebAuthFlow` (PKCE, authorization-code flow) for
 * tokens, resolves the user's identity, and issues a session.
 *
 * The extension's authorize-URL construction MUST request
 * `access_type=offline&prompt=consent` (Google) / the `offline_access`
 * scope (Microsoft) — without that, the provider won't return a refresh
 * token here, and this endpoint has no way to support background sync
 * without one, so it fails closed with a 400 rather than silently
 * creating an account that can never be synced in the background.
 */
async function handleCallback(c: Context<AppEnv>, providerName: OAuthProviderName, oauth: OAuthProvider) {
  const body = await c.req.json<CallbackBody>().catch(() => null);
  if (!body?.code || !body.codeVerifier || !body.redirectUri) {
    return c.json({ error: '"code", "codeVerifier", and "redirectUri" are required' }, 400);
  }

  const { userRepository, sessionRepository, tokenCipher } = c.get('deps');

  let tokens;
  try {
    tokens = await oauth.exchangeCode(body.code, body.codeVerifier, body.redirectUri);
  } catch (err) {
    console.error(`[auth/${providerName}] code exchange failed:`, err);
    return c.json({ error: 'Failed to exchange authorization code' }, 502);
  }

  if (!tokens.refreshToken) {
    return c.json(
      {
        error:
          'No refresh token returned — the authorization request must include prompt=consent&access_type=offline (Google) or the offline_access scope (Microsoft).',
      },
      400
    );
  }

  const identity = await oauth.fetchIdentity(tokens.accessToken);
  const encrypted = await tokenCipher.encrypt(tokens.refreshToken);

  const user = await userRepository.upsertOAuthUser({
    provider: providerName,
    providerAccountId: identity.providerAccountId,
    email: identity.email,
    refreshTokenCiphertext: encrypted.ciphertext,
    refreshTokenIv: encrypted.iv,
    scope: tokens.scope,
  });

  const session = await sessionRepository.createSession(user.id);

  return c.json({ sessionToken: session.token, expiresAt: session.expiresAt, user });
}

/**
 * POST /api/v1/auth/google
 * POST /api/v1/auth/microsoft
 * Body: { code, codeVerifier, redirectUri }
 */
auth.post('/google', (c) => handleCallback(c, 'google', c.get('deps').googleOAuth));
auth.post('/microsoft', (c) => handleCallback(c, 'microsoft', c.get('deps').microsoftOAuth));

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
 * Returns the current user's profile — used by the extension's options
 * page to show who's signed in.
 */
auth.get('/me', requireSession, async (c) => {
  return c.json({ user: c.get('user') });
});
