import type { AuthenticatedUser } from '../env';

export interface UserWithPasswordHash extends AuthenticatedUser {
  passwordHash: string;
}

/**
 * Identity storage: just `users` — email + a PBKDF2 hash (see
 * services/password-hasher.ts). No OAuth provider linkage: this project
 * deliberately uses its own email/password flow instead of a third-party
 * identity provider.
 */
export interface UserRepository {
  findByEmail(email: string): Promise<UserWithPasswordHash | null>;
  createUser(email: string, passwordHash: string): Promise<AuthenticatedUser>;
  updatePasswordHash(userId: number, passwordHash: string): Promise<void>;
}

export class D1UserRepository implements UserRepository {
  constructor(private readonly db: D1Database) {}

  async findByEmail(email: string): Promise<UserWithPasswordHash | null> {
    return this.db
      .prepare(`SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?`)
      .bind(email)
      .first<UserWithPasswordHash>();
  }

  async createUser(email: string, passwordHash: string): Promise<AuthenticatedUser> {
    const insert = await this.db
      .prepare(`INSERT INTO users (email, password_hash) VALUES (?, ?)`)
      .bind(email, passwordHash)
      .run();

    return { id: insert.meta.last_row_id, email };
  }

  async updatePasswordHash(userId: number, passwordHash: string): Promise<void> {
    await this.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, userId).run();
  }
}
