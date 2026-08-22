import type { OAuthProvider, OAuthTokenResult, OAuthIdentity } from './oauth-provider';

// The "common" tenant accepts both personal Microsoft accounts (needed for
// personal OneDrive) and work/school (Entra) accounts — a single tenant
// endpoint that works for "sign in with Microsoft" broadly, not just one
// account type.
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me';

export class MicrosoftOAuthProvider implements OAuthProvider {
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
      throw new Error(`Microsoft token exchange failed: ${response.status} ${await response.text()}`);
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
      throw new Error(`Microsoft token refresh failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope: string;
      refresh_token?: string;
    };

    // Unlike Google, Microsoft's v2 endpoint typically ROTATES the refresh
    // token on every refresh — the old one can stop working once a new one
    // is issued, so callers MUST persist this when present, not assume the
    // stored refresh token stays valid indefinitely like Google's does.
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      scope: data.scope,
      refreshToken: data.refresh_token ?? null,
    };
  }

  async fetchIdentity(accessToken: string): Promise<OAuthIdentity> {
    const response = await fetch(GRAPH_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Microsoft Graph /me fetch failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { id: string; mail: string | null; userPrincipalName: string };
    // `mail` is null for some account configurations — userPrincipalName is
    // always present and is usually the sign-in email, so it's a safe
    // fallback rather than failing identity resolution outright.
    return { providerAccountId: data.id, email: data.mail ?? data.userPrincipalName };
  }
}
