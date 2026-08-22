-- migrations/0003_add_embedded_at.sql
-- Purely additive: one nullable column on the existing `bookmarks` table.
-- Safe to run against the live database without affecting current rows —
-- every existing bookmark just starts with embedded_at = NULL, meaning
-- "not yet backfilled" (see POST /api/v1/admin/backfill-embeddings).
--
-- Run locally:  wrangler d1 execute bookmarks-db --file=./migrations/0003_add_embedded_at.sql
-- Run remote:   wrangler d1 execute bookmarks-db --remote --file=./migrations/0003_add_embedded_at.sql

ALTER TABLE bookmarks ADD COLUMN embedded_at TEXT;
