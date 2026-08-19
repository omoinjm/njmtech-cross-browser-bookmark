import type { CategoryCount } from '../env';
import { MAX_CATEGORY_CHARS } from '../lib/validation';

export interface CategoryReorgSuggestion {
  from: string;
  to: string;
  reason: string;
}

/**
 * Analyzes the full category list as a whole and proposes renames/merges for
 * ones that are poorly organized (duplicates, over-nested single-item
 * folders, ambiguous overlapping names) — leaving well-organized categories
 * alone. Unlike CategoryClassifier (which picks from existing categories
 * only), `to` here is intentionally a new proposed name: that's the point of
 * reorganizing. `from` is still constrained to real existing categories,
 * enforced in code — see below.
 */
export interface CategoryReorganizer {
  suggest(categories: CategoryCount[]): Promise<CategoryReorgSuggestion[]>;
}

// A one-shot, user-triggered analysis (not a per-bookmark background call),
// so a larger/more capable model is worth the extra latency here — this
// needs to reason holistically across the whole category list at once,
// which is a harder task than classifying one bookmark into an existing list.
const REORG_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const MAX_REASON_CHARS = 200;

export class WorkersAiCategoryReorganizer implements CategoryReorganizer {
  constructor(private readonly ai: Ai) {}

  async suggest(categories: CategoryCount[]): Promise<CategoryReorgSuggestion[]> {
    if (categories.length === 0) return [];

    try {
      const response = await this.ai.run(REORG_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              'You are helping reorganize a personal bookmark folder structure. You will be given a ' +
              'flat list of categories (each a "/"-separated folder path) with how many bookmarks use ' +
              'each one exactly. Some represent poor organization: duplicate or near-duplicate concepts ' +
              'under different names or locations, folders nested many levels deep for only 1-2 ' +
              'bookmarks, or ambiguous overlapping sibling categories.\n\n' +
              'Propose a rename or merge ONLY for categories with a real, specific problem. Most ' +
              'categories are probably already fine and should NOT appear in your output — do not pad ' +
              'the list to seem thorough.\n\n' +
              'Respond with ONLY a JSON array, no prose, no markdown fences. Each element: ' +
              '{"from": "<category path, copied EXACTLY from the list below>", ' +
              '"to": "<new proposed path>", "reason": "<reason, under 15 words>"}. ' +
              '"from" must be copied verbatim from the provided list — never invent one. ' +
              'If nothing needs to change, respond with exactly: []',
          },
          {
            role: 'user',
            content: categories.map((c) => `${c.category}: ${c.count}`).join('\n'),
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

      // Enforce "from must be a real category" in code, not just the prompt
      // — an LLM ignoring instructions could otherwise smuggle in a
      // fabricated source category that doesn't match anything real.
      const validFrom = new Set(categories.map((c) => c.category));

      return parsed
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          from: typeof item.from === 'string' ? item.from.trim() : '',
          to: typeof item.to === 'string' ? item.to.trim().slice(0, MAX_CATEGORY_CHARS) : '',
          reason: typeof item.reason === 'string' ? item.reason.trim().slice(0, MAX_REASON_CHARS) : '',
        }))
        .filter((item) => validFrom.has(item.from) && item.to.length > 0 && item.to !== item.from);
    } catch (err) {
      console.error('[WorkersAiCategoryReorganizer] suggest failed:', err);
      return [];
    }
  }
}
