/**
 * Bindings declared in wrangler.toml:
 *  - DB:        D1 database (bookmarks + bookmarks_fts)
 *  - AI:        Workers AI, used for auto-tagging
 *  - BROWSER:   Browser Rendering, used to scrape title/body text
 *
 * Secret (set via `wrangler secret put API_TOKEN`, never committed):
 *  - API_TOKEN: shared bearer token the browser extension authenticates with
 */
export interface Env {
  DB: D1Database;
  AI: Ai;
  BROWSER: Fetcher;
  API_TOKEN: string;
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
