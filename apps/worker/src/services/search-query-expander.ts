/**
 * Broadens a search query with AI-suggested related terms before it hits the
 * full-text index — e.g. "containers" -> ["docker", "kubernetes"] if those
 * are tags actually in use, so a search for "js" can still surface a
 * bookmark tagged/titled "javascript" even though plain prefix-matching FTS
 * wouldn't connect the two. Route code depends on this interface, not on
 * Workers AI directly.
 */
export interface SearchQueryExpander {
  /**
   * Returns 0-5 short additional search terms related to `query`, grounded
   * in the tags/categories actually used in this bookmark collection (so
   * expansions are terms likely to actually appear on a relevant bookmark,
   * not generic synonyms unrelated to what's stored). Returns [] on any
   * failure, or when there's nothing to ground suggestions in yet — the
   * caller always still searches on the original query.
   */
  expand(query: string, existingTags: string[], existingCategories: string[]): Promise<string[]>;
}

// The larger model also used for whole-category reorganization, not the
// small/fast one used for per-bookmark tagging/categorizing — this only ever
// runs on a zero-result search (rare), so the extra latency is a non-issue,
// and it matters here: the 8B model, even with an explicitly conservative
// prompt, kept reaching for generic/popular tags as "related" for queries
// that don't actually relate to anything (confirmed live with a nonsense
// query). The 70B model follows the "return [] when unsure" instruction
// far more reliably.
const EXPANSION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class WorkersAiSearchQueryExpander implements SearchQueryExpander {
  constructor(private readonly ai: Ai) {}

  async expand(query: string, existingTags: string[], existingCategories: string[]): Promise<string[]> {
    if (!query.trim()) return [];
    if (existingTags.length === 0 && existingCategories.length === 0) return [];

    try {
      const response = await this.ai.run(EXPANSION_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              'You help broaden a bookmark search that has already found ZERO results. Given the search ' +
              "query and the tags/categories actually used in this bookmark collection, respond with ONLY " +
              "a JSON array of 0 to 5 short additional search terms (single or two words) that are " +
              "SPECIFICALLY and CLEARLY related to the query's meaning. Strongly prefer terms drawn " +
              "directly from the provided lists over invented ones. Being popular or common is NOT a " +
              "reason to include a term — every term you return must have a real, explainable connection " +
              "to the query. If the query is vague, nonsensical, a typo you can't resolve, or nothing in " +
              "the lists is genuinely related, respond with an empty array: [] — an empty array is a " +
              "correct and expected answer, not a failure. No prose, no markdown fences, no explanation " +
              '— just the JSON array, e.g. ["docker","kubernetes"] for a query like "containers".',
          },
          {
            role: 'user',
            content:
              `Search query: ${query}\n\n` +
              `Tags in use:\n${existingTags.join(', ')}\n\n` +
              `Categories in use:\n${existingCategories.join(', ')}`,
          },
        ],
      });

      // This model's Workers AI wrapper sometimes returns `.response`
      // already parsed into an array (JSON mode), not a string to
      // regex-match — see the identical handling in category-reorganizer.ts,
      // which uses the same model.
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

      // Never echo the query back as its own "expansion" — the base FTS
      // query already covers it, so this would just be redundant noise.
      const queryLower = query.trim().toLowerCase();
      return parsed
        .filter((term): term is string => typeof term === 'string')
        .map((term) => term.trim())
        .filter((term) => term && term.toLowerCase() !== queryLower)
        .slice(0, 5);
    } catch (err) {
      console.error('[WorkersAiSearchQueryExpander] expand failed:', err);
      return [];
    }
  }
}
