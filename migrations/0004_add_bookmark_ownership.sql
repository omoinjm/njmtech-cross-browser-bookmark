-- migrations/0004_add_bookmark_ownership.sql
-- Adds real per-user ownership to `bookmarks`. Must run AFTER
-- 0002_add_users_and_sessions.sql (this references users(id)).
--
-- The live table has a column-level UNIQUE(url) that SQLite cannot ALTER
-- into a composite UNIQUE(user_id, url) in place, so this uses the standard
-- SQLite rebuild pattern: rename the old table, create the new shape, copy
-- every row across (user_id stays NULL — no user exists yet at migration
-- time), drop the old table, then rebuild bookmarks_fts fresh from the new
-- table (simplest way to guarantee the FTS rowid linkage survives the
-- swap, cheap at this table's size) and recreate its triggers identically
-- to schema.sql.
--
-- user_id is left nullable at the schema level rather than a second
-- rebuild to enforce NOT NULL — application code always populates it going
-- forward; the only NULL rows are these pre-migration legacy ones, until
-- the one-off backfill below claims them.
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0004_add_bookmark_ownership.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0004_add_bookmark_ownership.sql

-- The old triggers stay bound to the table NAME "bookmarks", not the
-- specific table object — D1/SQLite re-resolves that name dynamically, so
-- once a new table named "bookmarks" exists below, the OLD trigger bodies
-- (referencing bookmarks_fts, dropped here) would fire against it and fail.
-- Must drop these before the rename/recreate, not just at the end.
DROP TRIGGER IF EXISTS bookmarks_ai;
DROP TRIGGER IF EXISTS bookmarks_ad;
DROP TRIGGER IF EXISTS bookmarks_au;
DROP TABLE IF EXISTS bookmarks_fts;

ALTER TABLE bookmarks RENAME TO bookmarks_old;

CREATE TABLE bookmarks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  url          TEXT NOT NULL,
  title        TEXT,
  body_text    TEXT,
  tags         TEXT,
  category     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  embedded_at  TEXT,
  UNIQUE (user_id, url)
);

INSERT INTO bookmarks (id, url, title, body_text, tags, category, status, created_at, updated_at, embedded_at)
SELECT id, url, title, body_text, tags, category, status, created_at, updated_at, embedded_at
FROM bookmarks_old;

DROP TABLE bookmarks_old;

CREATE INDEX idx_bookmarks_status ON bookmarks (status);
CREATE INDEX idx_bookmarks_category ON bookmarks (category);
CREATE INDEX idx_bookmarks_user_id ON bookmarks (user_id);

CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
  title,
  body_text,
  tags,
  category,
  content   = 'bookmarks',
  content_rowid = 'id',
  tokenize  = 'porter unicode61'
);

INSERT INTO bookmarks_fts (rowid, title, body_text, tags, category)
SELECT id, title, body_text, tags, category FROM bookmarks;

CREATE TRIGGER bookmarks_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (rowid, title, body_text, tags, category)
  VALUES (new.id, new.title, new.body_text, new.tags, new.category);
END;

CREATE TRIGGER bookmarks_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (bookmarks_fts, rowid, title, body_text, tags, category)
  VALUES ('delete', old.id, old.title, old.body_text, old.tags, old.category);
END;

CREATE TRIGGER bookmarks_au AFTER UPDATE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (bookmarks_fts, rowid, title, body_text, tags, category)
  VALUES ('delete', old.id, old.title, old.body_text, old.tags, old.category);
  INSERT INTO bookmarks_fts (rowid, title, body_text, tags, category)
  VALUES (new.id, new.title, new.body_text, new.tags, new.category);
END;
