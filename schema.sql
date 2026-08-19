-- schema.sql
-- Run locally:  wrangler d1 execute bookmarks-db --file=./schema.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./schema.sql

DROP TABLE IF EXISTS bookmarks_fts;
DROP TABLE IF EXISTS bookmarks;

-- Main table. `status` tracks the async scrape/tag pipeline so the API can
-- return instantly on POST and let waitUntil() fill in the rest later.
--
-- `category` vs `tags`: category is a single hierarchical path (e.g.
-- "Dev Tools/AI APIs") mirroring the user's real browser folder structure —
-- one bookmark, one category. `tags` is a freeform JSON array from AI
-- tagging — one bookmark, many tags. Category is set once at creation
-- (from the real folder, or an AI suggestion for unfiled bookmarks) and
-- never overwritten afterward; tags are (re)written by the tagging pipeline.
CREATE TABLE bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL UNIQUE,
  title      TEXT,
  body_text  TEXT,
  tags       TEXT,                          -- JSON array, e.g. ["ai","tooling"]
  category   TEXT,                          -- e.g. "Dev Tools/AI APIs & Integrations"
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bookmarks_status ON bookmarks (status);
CREATE INDEX idx_bookmarks_category ON bookmarks (category);

-- FTS5 virtual table using the "external content" pattern: it stores no data
-- of its own, just an inverted index over bookmarks.title/body_text/tags/
-- category, keyed by bookmarks.id via content_rowid. This avoids duplicating
-- the (potentially large) scraped body text a second time on disk.
CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
  title,
  body_text,
  tags,
  category,
  content   = 'bookmarks',
  content_rowid = 'id',
  tokenize  = 'porter unicode61'
);

-- Keep the FTS index in lockstep with the source table. With external-content
-- tables, SQLite can't auto-populate the index, so every write path needs an
-- explicit trigger — including a matching 'delete' command before any UPDATE
-- so the old row's tokens are removed before the new ones are indexed.
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
