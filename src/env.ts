/**
 * Bindings declared in wrangler.toml:
 *  - DB:        D1 database (bookmarks + bookmarks_fts)
 *  - AI:        Workers AI, used for auto-tagging and embeddings
 *  - BROWSER:   Browser Rendering, used to scrape title/body text
 *  - VECTORIZE: Vectorize index storing one embedding per processed
 *    bookmark, used for semantic search — see services/embedding-generator.ts
 *    and services/semantic-index.ts.
 *  - USER_ACTOR: Durable Object namespace (class UserActor) — one instance
 *    per user, serializing that user's Drive/OneDrive file writes and
 *    tracking their fair-use AI rate limit.
 *
 * Secrets (set via `wrangler secret put <NAME>`, never committed):
 *  - API_TOKEN: legacy shared bearer token — kept only until the Phase 5
 *    rollout cutover (see migration plan), then deleted.
 *  - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: Google OAuth app credentials.
 *  - MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET: Microsoft Entra app
 *    registration credentials.
 *  - TOKEN_ENCRYPTION_KEY: 32-byte base64 AES-256-GCM key used to encrypt
 *    stored OAuth refresh tokens at rest (see services/token-cipher.ts).
 */
export interface Env {
  DB: D1Database;
  AI: Ai;
  BROWSER: Fetcher;
  VECTORIZE: VectorizeIndex;
  USER_ACTOR: DurableObjectNamespace;
  API_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

export type BookmarkStatus = 'pending' | 'processed' | 'failed';

export interface BookmarkRow {
  id: number;
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

export type OAuthProviderName = 'google' | 'microsoft';

export interface AuthenticatedUser {
  id: number;
  email: string;
}
