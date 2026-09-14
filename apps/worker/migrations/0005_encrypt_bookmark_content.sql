-- migrations/0005_encrypt_bookmark_content.sql
-- Rebuilds `bookmarks` so plaintext source columns become nullable migration
-- fallbacks, adds encrypted/blind-index columns, and replaces the old
-- plaintext FTS with a derived hashed-term index plus tag lookup table.
--
-- IMPORTANT: this schema migration prepares the database only. Existing rows
-- stay readable in the legacy plaintext columns until the Worker-side
-- backfill runs (POST /api/v1/admin/backfill-bookmark-encryption, or the
-- scheduled maintenance job) and scrubs them in place.
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0005_encrypt_bookmark_content.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0005_encrypt_bookmark_content.sql

DROP TRIGGER IF EXISTS bookmarks_ai;
DROP TRIGGER IF EXISTS bookmarks_ad;
DROP TRIGGER IF EXISTS bookmarks_au;
DROP TABLE IF EXISTS bookmarks_fts;
DROP TABLE IF EXISTS bookmark_tag_lookup;

ALTER TABLE bookmarks RENAME TO bookmarks_old;

CREATE TABLE bookmarks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER REFERENCES users(id),
  url                TEXT,
  title              TEXT,
  body_text          TEXT,
  tags               TEXT,
  category           TEXT,
  url_encrypted      TEXT,
  title_encrypted    TEXT,
  body_text_encrypted TEXT,
  tags_encrypted     TEXT,
  category_encrypted TEXT,
  url_lookup         TEXT,
  category_lookup    TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  embedded_at        TEXT,
  UNIQUE (user_id, url_lookup)
);

INSERT INTO bookmarks (
  id, user_id, url, title, body_text, tags, category, status, created_at, updated_at, embedded_at
)
SELECT
  id, user_id, url, title, body_text, tags, category, status, created_at, updated_at, embedded_at
FROM bookmarks_old;

DROP TABLE bookmarks_old;

CREATE INDEX idx_bookmarks_status ON bookmarks (status);
CREATE INDEX idx_bookmarks_user_id ON bookmarks (user_id);
CREATE INDEX idx_bookmarks_category_lookup ON bookmarks (category_lookup);

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
