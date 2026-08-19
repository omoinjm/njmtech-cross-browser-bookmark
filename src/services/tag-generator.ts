/**
 * Generates category tags for a bookmark from its scraped content. Route/
 * pipeline code depends on this interface, not on Workers AI directly — a
 * different tagging model/provider just means a new implementation.
 */
export interface TagGenerator {
  generateTags(title: string, bodyText: string): Promise<string[]>;
}

// @cf/meta/llama-3.1-8b-instruct was deprecated 2026-05-30 (Cloudflare's
// error pointed at its internal successor, @cf/meta/infire-llama-3.1-8b-
// instruct, which no longer exists either) — every tagging call had been
// silently failing since then, caught below and swallowed as `[]`. This is
// the same class/size model, just FP8-quantized.
const TAGGING_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

export class WorkersAiTagGenerator implements TagGenerator {
  constructor(private readonly ai: Ai) {}

  /**
   * Asks the tagging model for 3-5 short category tags and defensively parses
   * the response, since LLMs occasionally wrap JSON in prose or markdown
   * fences despite instructions.
   */
  async generateTags(title: string, bodyText: string): Promise<string[]> {
    if (!bodyText && !title) return [];

    try {
      const response = await this.ai.run(TAGGING_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              'You are a tagging assistant. Read the page title and content, then respond with ONLY ' +
              'a JSON array of 3 to 5 short, lowercase, single-or-two-word category tags. ' +
              'No prose, no markdown fences, no explanation — just the JSON array, e.g. ["ai","tooling","cloudflare"].',
          },
          {
            role: 'user',
            content: `Title: ${title}\n\nContent:\n${bodyText}`,
          },
        ],
      });

      const raw = typeof response === 'string' ? response : (response as { response?: string }).response ?? '';
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 5);
    } catch (err) {
      console.error('[WorkersAiTagGenerator] generateTags failed:', err);
      return [];
    }
  }
}
