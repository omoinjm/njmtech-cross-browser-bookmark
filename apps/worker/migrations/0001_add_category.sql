-- migrations/0001_add_category.sql
-- Non-destructive: adds the `category` column to an EXISTING bookmarks-db
-- without touching existing rows. Only the derived FTS index and its
-- triggers are dropped/rebuilt (safe — they hold no source-of-truth data,
-- just a computed index over the real `bookmarks` table).
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0001_add_category.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0001_add_category.sql
--
-- schema.sql already includes `category` for fresh installs — only run this
-- migration against a database created before this column existed.

ALTER TABLE bookmarks ADD COLUMN category TEXT;
CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks (category);

DROP TRIGGER IF EXISTS bookmarks_ai;
DROP TRIGGER IF EXISTS bookmarks_ad;
DROP TRIGGER IF EXISTS bookmarks_au;
DROP TABLE IF EXISTS bookmarks_fts;

CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
  title,
  body_text,
  tags,
  category,
  content   = 'bookmarks',
  content_rowid = 'id',
  tokenize  = 'porter unicode61'
);

-- Repopulates the new FTS table from the existing bookmarks rows.
INSERT INTO bookmarks_fts (bookmarks_fts) VALUES ('rebuild');

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
