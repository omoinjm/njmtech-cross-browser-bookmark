import type { BookmarkRepository } from '../repositories/bookmark-repository';
import type { PageScraper } from './page-scraper';
import type { TagGenerator } from './tag-generator';
import type { CategoryClassifier } from './category-classifier';

export interface ProcessOptions {
  // Only meaningful when the bookmark had no category at creation time (no
  // real browser folder). Never overrides a category the client already
  // supplied — see bookmarks.ts, which only sets this true in that case.
  suggestCategory: boolean;
}

/**
 * Orchestrates the scrape -> tag -> categorize -> persist pipeline for a
 * single bookmark. Depends only on the repository/scraper/tagger/classifier
 * abstractions (constructor injection), so it's testable with fakes and
 * swappable independently of whatever concrete storage/scraping/tagging/
 * classification backends the route layer wires up at the composition root.
 */
export class BookmarkIngestionPipeline {
  constructor(
    private readonly repository: BookmarkRepository,
    private readonly scraper: PageScraper,
    private readonly tagger: TagGenerator,
    private readonly categoryClassifier: CategoryClassifier
  ) {}

  async process(id: number, url: string, options: ProcessOptions): Promise<void> {
    try {
      const { title, bodyText } = await this.scraper.scrape(url);
      const tags = await this.tagger.generateTags(title, bodyText);

      await this.repository.markProcessed(id, title || url, bodyText, tags);

      if (options.suggestCategory) {
        await this.applyCategorySuggestion(id, title, bodyText);
      }
    } catch (err) {
      console.error(`[BookmarkIngestionPipeline] failed for bookmark ${id} (${url}):`, err);
      await this.repository.markFailed(id);
    }
  }

  /**
   * Backfills a category for a bookmark that was synced before it had one —
   * either from an earlier import (pre-dating this feature) or one created
   * without `suggestCategory`. Re-uses the already-scraped title/body_text
   * already on the row; no re-scrape. Called from bookmarks.ts's dedupe path
   * when a re-synced bookmark already exists but still has no category.
   */
  async categorizeExisting(id: number): Promise<void> {
    const bookmark = await this.repository.findById(id);
    if (!bookmark || bookmark.category) return;

    await this.applyCategorySuggestion(id, bookmark.title ?? '', bookmark.body_text ?? '');
  }

  private async applyCategorySuggestion(id: number, title: string, bodyText: string): Promise<void> {
    const existingCategories = (await this.repository.listCategories()).map((c) => c.category);
    const suggestion = await this.categoryClassifier.classify(title, bodyText, existingCategories);
    if (suggestion) {
      await this.repository.updateCategory(id, suggestion);
    }
  }
}
