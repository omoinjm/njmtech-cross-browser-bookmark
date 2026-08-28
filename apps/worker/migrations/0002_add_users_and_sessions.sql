-- migrations/0002_add_users_and_sessions.sql
-- Purely additive: two new tables for real per-user accounts (email +
-- auto-generated password, emailed via njmtech-email-template-api — no
-- third-party identity provider). Does not touch the existing `bookmarks`/
-- `bookmarks_fts` tables at all — bookmark ownership is a separate
-- migration (see 0004_add_bookmark_ownership.sql). Safe to run against the
-- live database without affecting current single-tenant usage in any way.
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0002_add_users_and_sessions.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0002_add_users_and_sessions.sql

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  -- PBKDF2 output as one self-describing string (algorithm$iterations$salt$hash)
  -- — see services/password-hasher.ts. No separate salt column needed.
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opaque bearer session tokens the extension authenticates with, replacing
-- the single shared API_TOKEN. Only the SHA-256 hash of the token is
-- stored — the raw token is returned to the client exactly once (at
-- sign-in) and is unrecoverable from this table alone.
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
