-- migrations/0002_add_users_and_sessions.sql
-- Purely additive: three new tables for the multi-tenant auth layer.
-- Does not touch the existing `bookmarks`/`bookmarks_fts` tables at all —
-- that per-user scoping is a separate, later migration (see the
-- multi-tenant redesign plan). Safe to run against the live database
-- without affecting current single-tenant usage in any way.
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0002_add_users_and_sessions.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0002_add_users_and_sessions.sql

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (provider, provider account) a user has signed in with.
-- Refresh tokens are stored encrypted (AES-256-GCM via services/token-
-- cipher.ts) — never in plaintext. `scope` is recorded so a future refresh
-- can confirm the token still grants what's expected before relying on it.
CREATE TABLE oauth_accounts (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  INTEGER NOT NULL REFERENCES users(id),
  provider                 TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_account_id      TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv         TEXT NOT NULL,
  scope                    TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_account_id)
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

CREATE INDEX idx_oauth_accounts_user_id ON oauth_accounts (user_id);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
