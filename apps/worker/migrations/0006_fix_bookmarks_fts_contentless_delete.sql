-- migrations/0006_fix_bookmarks_fts_contentless_delete.sql
-- 0005 created bookmarks_fts as a contentless FTS5 table (content = '') but
-- the app issues the FTS5 'delete' special command against it (see
-- bookmark-repository.ts). Contentless tables only support 'delete' safely
-- when created with contentless_delete=1 — without it, 'delete' corrupts the
-- index (undefined behavior per SQLite's own FTS5 docs). Recreate the table
-- with that option. Safe to drop: the index is fully derived and gets
-- rebuilt from the (possibly encrypted) source columns, never a source of
-- truth itself.
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0006_fix_bookmarks_fts_contentless_delete.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0006_fix_bookmarks_fts_contentless_delete.sql

DROP TABLE IF EXISTS bookmarks_fts;

CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
  search_terms,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61'
);
