-- schema.sql
-- Run locally:  wrangler d1 execute bookmarks-db --file=./schema.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./schema.sql

DROP TABLE IF EXISTS bookmarks_fts;
DROP TABLE IF EXISTS bookmarks;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

-- Real accounts: email + an auto-generated password emailed via
-- njmtech-email-template-api (see services/email-sender.ts) — no
-- third-party identity provider. Must exist before `bookmarks`, which
-- references it.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  -- PBKDF2 output as one self-describing string (algorithm$iterations$salt$hash)
  -- — see services/password-hasher.ts. No separate salt column needed.
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opaque bearer session tokens the extension authenticates with. Only the
-- SHA-256 hash of the token is stored — the raw token is returned to the
-- client exactly once, at sign-in.
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- Main table. `status` tracks the async scrape/tag pipeline so the API can
-- return instantly on POST and let waitUntil() fill in the rest later.
--
-- Source bookmark fields are encrypted by the Worker before they land in the
-- `*_encrypted` columns. The plaintext columns are migration-only fallbacks:
-- fresh installs keep them NULL, and the encryption backfill route scrubs any
-- legacy rows that still use them.
--
-- `category` vs `tags`: category is a single hierarchical path (e.g.
-- "Dev Tools/AI APIs") mirroring the user's real browser folder structure —
-- one bookmark, one category. `tags` is a freeform JSON array from AI
-- tagging — one bookmark, many tags. Category is set once at creation
-- (from the real folder, or an AI suggestion for unfiled bookmarks) and
-- never overwritten afterward; tags are (re)written by the tagging pipeline.
--
-- `UNIQUE (user_id, url_lookup)`, not a bare unique url: two different users
-- bookmarking the same URL are two independent rows, each scoped to its own
-- owner — see BookmarkRepository, where every method takes a userId and
-- enforces it in its WHERE clause as a hard security boundary, not just a
-- convenience filter.
CREATE TABLE bookmarks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  url          TEXT,
  title        TEXT,
  body_text    TEXT,
  tags         TEXT,                          -- JSON array, e.g. ["ai","tooling"]
  category     TEXT,                          -- e.g. "Dev Tools/AI APIs & Integrations"
  url_encrypted TEXT NOT NULL,
  title_encrypted TEXT,
  body_text_encrypted TEXT,
  tags_encrypted TEXT,
  category_encrypted TEXT,
  url_lookup   TEXT NOT NULL,                 -- keyed exact-match blind index for dedupe / patch / delete
  category_lookup TEXT,                       -- keyed exact-match blind index for category filtering
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set once a semantic-search embedding for this row has been generated and
  -- stored in Vectorize (see services/embedding-generator.ts and the
  -- /admin/backfill-embeddings route) — null until then. The embedding
  -- itself lives only in Vectorize, keyed by this row's id; this column is
  -- just "has it been done" bookkeeping so a backfill run can skip rows
  -- that already have one.
  embedded_at  TEXT,
  UNIQUE (user_id, url_lookup)
);

CREATE INDEX idx_bookmarks_status ON bookmarks (status);
CREATE INDEX idx_bookmarks_user_id ON bookmarks (user_id);
CREATE INDEX idx_bookmarks_category_lookup ON bookmarks (category_lookup);

-- Fast keyword search uses hashed search terms instead of plaintext copies of
-- bookmark content. The Worker computes and writes these terms explicitly.
CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
  search_terms,
  content = '',
  tokenize = 'unicode61'
);

CREATE TABLE bookmark_tag_lookup (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  tag_lookup  TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, tag_lookup)
);

CREATE INDEX idx_bookmark_tag_lookup_user_tag ON bookmark_tag_lookup (user_id, tag_lookup);
