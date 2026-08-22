/**
 * One shared shape for both Google and Microsoft OAuth — the extension
 * uses the same `browser.identity.launchWebAuthFlow` + authorization-code
 * + PKCE flow for both, so the backend's code-exchange/refresh/identity
 * steps only ever need one interface, not provider-specific route logic.
 */
export interface OAuthTokenResult {
  accessToken: string;
  expiresIn: number;
  scope: string;
  /**
   * Google only returns a refresh token on the very first consent (with
   * `access_type=offline`) and never on a subsequent refresh — Microsoft's
   * v2 endpoint, by contrast, typically rotates and returns a NEW refresh
   * token on every refresh, and the old one may stop working once that
   * happens. `null` means "no new refresh token was issued, keep using the
   * one already stored"; a non-null value means "persist this, replacing
   * the old one" — callers must not assume either behavior for both
   * providers.
   */
  refreshToken: string | null;
}

export interface OAuthIdentity {
  providerAccountId: string;
  email: string;
}

export interface OAuthProvider {
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthTokenResult>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult>;
  fetchIdentity(accessToken: string): Promise<OAuthIdentity>;
}
