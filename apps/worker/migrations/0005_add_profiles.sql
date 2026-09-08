-- migrations/0005_add_profiles.sql
-- Adds Profiles (e.g. "Personal", "Work", or any user-chosen name) as a
-- layer between a user and their bookmarks — every bookmark now belongs to
-- exactly one profile, and profiles are strictly siloed from each other.
--
-- Same SQLite rebuild pattern as 0004_add_bookmark_ownership.sql, for the
-- same reason: UNIQUE(user_id, url) can't be ALTERed into
-- UNIQUE(user_id, profile_id, url) in place.
--
-- profile_id is left nullable at the schema level, same rationale as
-- user_id in 0004: application code always populates it going forward, and
-- the backfill below claims every currently-owned row into a new "Personal"
-- profile per user (one per user who owns at least one bookmark) — only
-- unclaimed (user_id IS NULL) legacy rows stay profile_id IS NULL too.
--
-- Run locally:  wrangler d1 execute bookmarks-db --local --file=./migrations/0005_add_profiles.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0005_add_profiles.sql

CREATE TABLE profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);

CREATE INDEX idx_profiles_user_id ON profiles (user_id);

-- One "Personal" profile per user who already owns at least one bookmark —
-- the lazy per-request auto-seed (ProfileRepository.getOrCreateDefault)
-- handles every other case (a user with zero bookmarks, or a brand new
-- signup) going forward.
INSERT INTO profiles (user_id, name)
SELECT DISTINCT user_id, 'Personal' FROM bookmarks WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS bookmarks_ai;
DROP TRIGGER IF EXISTS bookmarks_ad;
DROP TRIGGER IF EXISTS bookmarks_au;
DROP TABLE IF EXISTS bookmarks_fts;

ALTER TABLE bookmarks RENAME TO bookmarks_old;

CREATE TABLE bookmarks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  profile_id   INTEGER REFERENCES profiles(id),
  url          TEXT NOT NULL,
  title        TEXT,
  body_text    TEXT,
  tags         TEXT,
  category     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  embedded_at  TEXT,
  UNIQUE (user_id, profile_id, url)
);

INSERT INTO bookmarks (id, user_id, profile_id, url, title, body_text, tags, category, status, created_at, updated_at, embedded_at)
SELECT
  b.id, b.user_id, p.id AS profile_id, b.url, b.title, b.body_text, b.tags, b.category, b.status, b.created_at, b.updated_at, b.embedded_at
FROM bookmarks_old b
LEFT JOIN profiles p ON p.user_id = b.user_id AND p.name = 'Personal';

DROP TABLE bookmarks_old;

CREATE INDEX idx_bookmarks_status ON bookmarks (status);
CREATE INDEX idx_bookmarks_profile_category ON bookmarks (profile_id, category);
CREATE INDEX idx_bookmarks_user_id ON bookmarks (user_id);
CREATE INDEX idx_bookmarks_profile_id ON bookmarks (profile_id);

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
