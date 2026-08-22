import type { OAuthProvider, OAuthTokenResult, OAuthIdentity } from './oauth-provider';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

export class GoogleOAuthProvider implements OAuthProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {}

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthTokenResult> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope: string;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      scope: data.scope,
      // Only present on the first consent (access_type=offline) — absent
      // on a plain refresh, which is expected, not an error.
      refreshToken: data.refresh_token ?? null,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error(`Google token refresh failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number; scope: string };

    // Google never returns a new refresh token on a plain refresh — the
    // caller keeps using the one it already has stored.
    return { accessToken: data.access_token, expiresIn: data.expires_in, scope: data.scope, refreshToken: null };
  }

  async fetchIdentity(accessToken: string): Promise<OAuthIdentity> {
    const response = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google userinfo fetch failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { sub: string; email: string };
    return { providerAccountId: data.sub, email: data.email };
  }
}
