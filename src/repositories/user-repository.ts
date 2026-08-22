import type { AuthenticatedUser, OAuthProviderName } from '../env';

export interface UpsertOAuthUserInput {
  provider: OAuthProviderName;
  providerAccountId: string;
  email: string;
  refreshTokenCiphertext: string;
  refreshTokenIv: string;
  scope: string;
}

export interface StoredRefreshToken {
  ciphertext: string;
  iv: string;
}

/**
 * Identity storage: `users` + `oauth_accounts`. Deliberately does NOT
 * attempt to link accounts across providers by matching email — the same
 * person signing in with Google one day and Microsoft another becomes two
 * separate users for now (cross-provider linking is explicitly deferred,
 * see the multi-tenant redesign plan). This keeps sign-in unambiguous: one
 * (provider, providerAccountId) pair always maps to exactly one user.
 */
export interface UserRepository {
  upsertOAuthUser(input: UpsertOAuthUserInput): Promise<AuthenticatedUser>;
  getRefreshToken(userId: number, provider: OAuthProviderName): Promise<StoredRefreshToken | null>;
  updateRefreshToken(
    userId: number,
    provider: OAuthProviderName,
    ciphertext: string,
    iv: string
  ): Promise<void>;
}

export class D1UserRepository implements UserRepository {
  constructor(private readonly db: D1Database) {}

  async upsertOAuthUser(input: UpsertOAuthUserInput): Promise<AuthenticatedUser> {
    const existing = await this.db
      .prepare(
        `SELECT u.id, u.email
         FROM oauth_accounts oa
         JOIN users u ON u.id = oa.user_id
         WHERE oa.provider = ? AND oa.provider_account_id = ?`
      )
      .bind(input.provider, input.providerAccountId)
      .first<AuthenticatedUser>();

    if (existing) {
      await this.db
        .prepare(
          `UPDATE oauth_accounts
           SET refresh_token_ciphertext = ?, refresh_token_iv = ?, scope = ?, updated_at = datetime('now')
           WHERE provider = ? AND provider_account_id = ?`
        )
        .bind(input.refreshTokenCiphertext, input.refreshTokenIv, input.scope, input.provider, input.providerAccountId)
        .run();
      return existing;
    }

    const insertUser = await this.db
      .prepare(`INSERT INTO users (email) VALUES (?)`)
      .bind(input.email)
      .run();
    const userId = insertUser.meta.last_row_id;

    await this.db
      .prepare(
        `INSERT INTO oauth_accounts
           (user_id, provider, provider_account_id, refresh_token_ciphertext, refresh_token_iv, scope)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, input.provider, input.providerAccountId, input.refreshTokenCiphertext, input.refreshTokenIv, input.scope)
      .run();

    return { id: userId, email: input.email };
  }

  async getRefreshToken(userId: number, provider: OAuthProviderName): Promise<StoredRefreshToken | null> {
    return this.db
      .prepare(
        `SELECT refresh_token_ciphertext AS ciphertext, refresh_token_iv AS iv
         FROM oauth_accounts
         WHERE user_id = ? AND provider = ?`
      )
      .bind(userId, provider)
      .first<StoredRefreshToken>();
  }

  async updateRefreshToken(
    userId: number,
    provider: OAuthProviderName,
    ciphertext: string,
    iv: string
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE oauth_accounts
         SET refresh_token_ciphertext = ?, refresh_token_iv = ?, updated_at = datetime('now')
         WHERE user_id = ? AND provider = ?`
      )
      .bind(ciphertext, iv, userId, provider)
      .run();
  }
}
