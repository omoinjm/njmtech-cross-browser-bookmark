/**
 * Suggests a category for a bookmark that has no real browser folder to
 * derive one from. Route/pipeline code depends on this interface, not on
 * Workers AI directly — a different classification model/provider just
 * means a new implementation.
 */
export interface CategoryClassifier {
  /**
   * Returns one of `existingCategories` (exact string), or null if none fit
   * well or there's nothing to classify against yet. Never invents a new
   * category — see the constraint enforced below.
   */
  classify(title: string, bodyText: string, existingCategories: string[]): Promise<string | null>;
}

const CLASSIFIER_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

export class WorkersAiCategoryClassifier implements CategoryClassifier {
  constructor(private readonly ai: Ai) {}

  async classify(title: string, bodyText: string, existingCategories: string[]): Promise<string | null> {
    if (existingCategories.length === 0) return null;
    if (!title && !bodyText) return null;

    try {
      const response = await this.ai.run(CLASSIFIER_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              'You categorize bookmarks into an existing set of categories. Read the page title and ' +
              'content, then respond with ONLY the single best-fitting category, copied EXACTLY as it ' +
              'appears in the provided list — no prose, no markdown, no quotes, no explanation. If ' +
              'none of the categories fit reasonably well, respond with exactly: NONE',
          },
          {
            role: 'user',
            content:
              `Categories:\n${existingCategories.map((c) => `- ${c}`).join('\n')}\n\n` +
              `Title: ${title}\n\nContent:\n${bodyText}`,
          },
        ],
      });

      const raw = typeof response === 'string' ? response : (response as { response?: string }).response ?? '';
      const candidate = raw.trim();

      // Enforce the "existing categories only" constraint in code, not just
      // in the prompt — an LLM can ignore instructions. Compare
      // case-insensitively/trimmed, but only ever return the exact stored
      // string, never the model's own casing/whitespace.
      const match = existingCategories.find(
        (category) => category.trim().toLowerCase() === candidate.toLowerCase()
      );
      return match ?? null;
    } catch (err) {
      console.error('[WorkersAiCategoryClassifier] classify failed:', err);
      return null;
    }
  }
}
