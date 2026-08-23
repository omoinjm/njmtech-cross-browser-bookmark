import type { BookmarkRepository } from '../repositories/bookmark-repository';
import type { PageScraper } from './page-scraper';
import type { TagGenerator } from './tag-generator';
import type { CategoryClassifier } from './category-classifier';
import type { EmbeddingGenerator } from './embedding-generator';
import type { SemanticIndex } from './semantic-index';
import { buildEmbeddingInput } from './embedding-generator';

export interface ProcessOptions {
  // Only meaningful when the bookmark had no category at creation time (no
  // real browser folder). Never overrides a category the client already
  // supplied — see bookmarks.ts, which only sets this true in that case.
  suggestCategory: boolean;
}

/**
 * Orchestrates the scrape -> tag -> categorize -> embed -> persist pipeline
 * for a single bookmark. Depends only on the repository/scraper/tagger/
 * classifier/embedding abstractions (constructor injection), so it's
 * testable with fakes and swappable independently of whatever concrete
 * storage/scraping/tagging/classification/embedding backends the route
 * layer wires up at the composition root.
 */
export class BookmarkIngestionPipeline {
  constructor(
    private readonly repository: BookmarkRepository,
    private readonly scraper: PageScraper,
    private readonly tagger: TagGenerator,
    private readonly categoryClassifier: CategoryClassifier,
    private readonly embeddingGenerator: EmbeddingGenerator,
    private readonly semanticIndex: SemanticIndex
  ) {}

  async process(userId: number, id: number, url: string, options: ProcessOptions): Promise<void> {
    try {
      const { title, bodyText } = await this.scraper.scrape(url);
      const tags = await this.tagger.generateTags(title, bodyText);
      const resolvedTitle = title || url;

      await this.repository.markProcessed(id, resolvedTitle, bodyText, tags);

      if (options.suggestCategory) {
        await this.applyCategorySuggestion(userId, id, title, bodyText);
      }

      await this.indexForSemanticSearch(userId, id, resolvedTitle, bodyText);
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
  async categorizeExisting(userId: number, id: number): Promise<void> {
    const bookmark = await this.repository.findById(userId, id);
    if (!bookmark || bookmark.category) return;

    await this.applyCategorySuggestion(userId, id, bookmark.title ?? '', bookmark.body_text ?? '');
  }

  private async applyCategorySuggestion(userId: number, id: number, title: string, bodyText: string): Promise<void> {
    const existingCategories = (await this.repository.listCategories(userId)).map((c) => c.category);
    const suggestion = await this.categoryClassifier.classify(title, bodyText, existingCategories);
    if (suggestion) {
      await this.repository.updateCategory(id, suggestion);
    }
  }

  // Best-effort: a failed embedding shouldn't fail the whole ingestion — the
  // bookmark is still fully usable via keyword search either way. Also used
  // by the /admin/backfill-embeddings route for anything created before
  // this existed (see that route for why embedded_at makes this idempotent).
  private async indexForSemanticSearch(userId: number, id: number, title: string, bodyText: string): Promise<void> {
    try {
      const vector = await this.embeddingGenerator.embed(buildEmbeddingInput(title, bodyText));
      await this.semanticIndex.upsert(id, userId, vector);
      await this.repository.markEmbedded(id);
    } catch (err) {
      console.error(`[BookmarkIngestionPipeline] embedding failed for bookmark ${id}:`, err);
    }
  }
}
