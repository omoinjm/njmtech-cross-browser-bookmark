/**
 * Bindings declared in wrangler.toml:
 *  - DB:        D1 database (bookmarks + bookmarks_fts + users/sessions)
 *  - AI:        Workers AI, used for auto-tagging and embeddings
 *  - BROWSER:   Browser Rendering, used to scrape title/body text
 *  - VECTORIZE: Vectorize index storing one embedding per processed
 *    bookmark, used for semantic search — see services/embedding-generator.ts
 *    and services/semantic-index.ts.
 *
 * No secrets: every route authenticates via a per-user session (see
 * middleware/require-session.ts) instead of a shared static token. Accounts
 * are email + an auto-generated password emailed via
 * services/email-sender.ts — no third-party identity provider is used.
 */
export interface Env {
  DB: D1Database;
  AI: Ai;
  BROWSER: Fetcher;
  VECTORIZE: VectorizeIndex;
}

export type BookmarkStatus = 'pending' | 'processed' | 'failed';

export interface BookmarkRow {
  id: number;
  // Nullable only for pre-migration legacy rows not yet claimed by the
  // one-off ownership backfill (see migrations/0004_add_bookmark_ownership.sql)
  // — every row created by application code always has one.
  user_id: number | null;
  url: string;
  title: string | null;
  body_text: string | null;
  tags: string | null;
  category: string | null;
  status: BookmarkStatus;
  created_at: string;
  updated_at: string;
  // Set once a semantic-search embedding has been generated and stored in
  // Vectorize (see BookmarkIngestionPipeline and the /admin/backfill-
  // embeddings route) — null for anything created before that existed, or
  // still pending/failed. Not the embedding vector itself, which lives only
  // in Vectorize, keyed by this row's id.
  embedded_at: string | null;
}

export interface BookmarkSearchResult extends BookmarkRow {
  snippet: string;
  rank: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

// A candidate bookmark for the reorganization prompt/re-validation — see
// category-reorganizer.ts and categories.ts's /reorganize route. `category`
// is nullable because listByIds (used to re-validate a bookmark-move
// suggestion at apply time) can return a bookmark whose category changed
// (e.g. cleared by hand) since the suggestion was generated.
export interface ReorgBookmarkRow {
  id: number;
  url: string;
  title: string | null;
  category: string | null;
}

export interface AuthenticatedUser {
  id: number;
  email: string;
}
