import type { CategoryCount, ReorgBookmarkRow } from '../env';
import { MAX_CATEGORY_CHARS } from '../lib/validation';

export interface CategoryRenameSuggestion {
  type: 'category';
  from: string;
  to: string;
  reason: string;
}

// `from`/`url`/`title` are always looked up from OUR OWN bookmark list
// (never trusted from the model) — see the validation logic below.
export interface BookmarkMoveSuggestion {
  type: 'bookmark';
  bookmarkId: number;
  url: string;
  title: string;
  from: string;
  to: string;
  reason: string;
}

export type ReorgSuggestion = CategoryRenameSuggestion | BookmarkMoveSuggestion;

/**
 * Analyzes the full category list AND every categorized bookmark's title at
 * once, and proposes two different kinds of fixes:
 *
 *  - Category-level: renaming/merging a WHOLE category that's itself poorly
 *    named or structured (duplicates, over-nested single-item folders,
 *    ambiguous overlapping names) — `to` here is intentionally a new
 *    proposed name, since that's the point of reorganizing.
 *  - Bookmark-level: moving a single MISFILED bookmark into a different
 *    EXISTING category, when the category it's currently in is otherwise
 *    fine for its other bookmarks — `to` here must be a category that
 *    already exists, never invented.
 *
 * Well-organized categories/bookmarks are left alone. `from` (category type)
 * and `to` (bookmark type) are both constrained to real existing categories,
 * enforced in code — see below.
 */
export interface CategoryReorganizer {
  suggest(categories: CategoryCount[], bookmarks: ReorgBookmarkRow[]): Promise<ReorgSuggestion[]>;
}

// A one-shot, user-triggered analysis (not a per-bookmark background call),
// so a larger/more capable model is worth the extra latency here — this
// needs to reason holistically across the whole category list (and now
// every bookmark's title) at once, which is a harder task than classifying
// one bookmark into an existing list.
const REORG_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const MAX_REASON_CHARS = 200;

export class WorkersAiCategoryReorganizer implements CategoryReorganizer {
  constructor(private readonly ai: Ai) {}

  async suggest(categories: CategoryCount[], bookmarks: ReorgBookmarkRow[]): Promise<ReorgSuggestion[]> {
    if (categories.length === 0) return [];

    // listForReorg already filters to categorized bookmarks, but this
    // service shouldn't assume its caller did — a bookmark with no category
    // can't be "misfiled" in the first place.
    const categorizedBookmarks = bookmarks.filter(
      (b): b is ReorgBookmarkRow & { category: string } => Boolean(b.category)
    );

    try {
      const response = await this.ai.run(REORG_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              'You are helping reorganize a personal bookmark library. You will be given two lists: the ' +
              'current categories ("/"-separated folder paths) with how many bookmarks use each one ' +
              'exactly, and every categorized bookmark with its id, current category, and title.\n\n' +
              'Look for two DIFFERENT kinds of problems, and propose a fix for EACH real one you find:\n\n' +
              '1. CATEGORY-LEVEL: a category itself is poorly named or structured — duplicate or ' +
              'near-duplicate concepts under different names, folders nested many levels deep for only ' +
              '1-2 bookmarks, or ambiguous overlapping sibling categories. Propose renaming/merging the ' +
              'WHOLE category:\n' +
              '{"type":"category","from":"<category path, copied EXACTLY from the list>",' +
              '"to":"<new proposed path>","reason":"<under 15 words>"}\n\n' +
              '2. BOOKMARK-LEVEL: one specific bookmark whose title clearly does not belong in its ' +
              'current category, even though that category is fine for the OTHER bookmarks in it, and it ' +
              'would clearly fit a DIFFERENT category that already exists. Propose moving just that ' +
              'bookmark:\n' +
              '{"type":"bookmark","bookmarkId":<id, copied EXACTLY from the list>,' +
              '"to":"<an EXISTING category path from the list, copied EXACTLY>","reason":"<under 15 words>"}\n\n' +
              'Only flag real, clear problems — most categories and bookmarks are probably already fine ' +
              'and should NOT appear in your output; do not pad the list to seem thorough. Never invent a ' +
              'new category for a bookmark-level move — "to" there must be one of the categories already ' +
              'in the list. Respond with ONLY a JSON array mixing both types as needed, no prose, no ' +
              'markdown fences. If nothing needs to change, respond with exactly: []',
          },
          {
            role: 'user',
            content:
              `Categories:\n${categories.map((c) => `${c.category}: ${c.count}`).join('\n')}\n\n` +
              `Bookmarks (id | category | title):\n${categorizedBookmarks
                .map((b) => `${b.id} | ${b.category} | ${b.title || b.url}`)
                .join('\n')}`,
          },
        ],
      });

      // This model's Workers AI wrapper sometimes returns `.response`
      // already parsed into an array/object (JSON mode), not a string to
      // regex-match like the smaller models used elsewhere in this project
      // — handle both shapes rather than assuming one.
      const responseField = (response as { response?: unknown })?.response;
      let parsed: unknown;

      if (Array.isArray(responseField)) {
        parsed = responseField;
      } else {
        const raw = typeof response === 'string' ? response : typeof responseField === 'string' ? responseField : '';
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) return [];
        parsed = JSON.parse(match[0]);
      }

      if (!Array.isArray(parsed)) return [];

      // Enforce every constraint in code, not just the prompt — an LLM
      // ignoring instructions could otherwise smuggle in a fabricated
      // source category, a nonexistent bookmark id, or a made-up
      // destination category for a bookmark move.
      const validCategories = new Set(categories.map((c) => c.category));
      const bookmarksById = new Map(categorizedBookmarks.map((b) => [b.id, b]));

      const suggestions: ReorgSuggestion[] = [];

      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;

        if (record.type === 'category') {
          const from = typeof record.from === 'string' ? record.from.trim() : '';
          const to = typeof record.to === 'string' ? record.to.trim().slice(0, MAX_CATEGORY_CHARS) : '';
          const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, MAX_REASON_CHARS) : '';

          if (validCategories.has(from) && to.length > 0 && to !== from) {
            suggestions.push({ type: 'category', from, to, reason });
          }
        } else if (record.type === 'bookmark') {
          const bookmarkId = typeof record.bookmarkId === 'number' ? record.bookmarkId : Number(record.bookmarkId);
          const bookmark = Number.isInteger(bookmarkId) ? bookmarksById.get(bookmarkId) : undefined;
          const to = typeof record.to === 'string' ? record.to.trim().slice(0, MAX_CATEGORY_CHARS) : '';
          const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, MAX_REASON_CHARS) : '';

          if (bookmark && validCategories.has(to) && to !== bookmark.category) {
            suggestions.push({
              type: 'bookmark',
              bookmarkId: bookmark.id,
              url: bookmark.url,
              title: bookmark.title || bookmark.url,
              from: bookmark.category,
              to,
              reason,
            });
          }
        }
      }

      return suggestions;
    } catch (err) {
      console.error('[WorkersAiCategoryReorganizer] suggest failed:', err);
      return [];
    }
  }
}
