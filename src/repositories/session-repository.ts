import type { AuthenticatedUser } from '../env';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

/**
 * Opaque bearer session tokens. Only a SHA-256 hash of the token is ever
 * persisted (`token_hash`) — the raw token is returned to the caller
 * exactly once, at creation, and cannot be recovered from the database
 * afterward. This mirrors how the API_TOKEN it replaces was a secret never
 * written to source, just carried further: now per-user instead of shared.
 */
export interface SessionRepository {
  createSession(userId: number): Promise<CreatedSession>;
  validateSession(token: string): Promise<AuthenticatedUser | null>;
  revokeSession(token: string): Promise<void>;
}

export class D1SessionRepository implements SessionRepository {
  constructor(private readonly db: D1Database) {}

  async createSession(userId: number): Promise<CreatedSession> {
    const token = generateOpaqueToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    await this.db
      .prepare(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)`)
      .bind(userId, tokenHash, expiresAt)
      .run();

    return { token, expiresAt };
  }

  async validateSession(token: string): Promise<AuthenticatedUser | null> {
    const tokenHash = await sha256Hex(token);
    return this.db
      .prepare(
        `SELECT u.id, u.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
      )
      .bind(tokenHash)
      .first<AuthenticatedUser>();
  }

  async revokeSession(token: string): Promise<void> {
    const tokenHash = await sha256Hex(token);
    await this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
  }
}

// 32 random bytes, base64url-encoded — long enough to make guessing
// infeasible, URL-safe so it can travel in headers/JSON without escaping.
function generateOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
