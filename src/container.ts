import type { Env } from './env';
import { D1BookmarkRepository, type BookmarkRepository } from './repositories/bookmark-repository';
import { BrowserRenderingScraper, type PageScraper } from './services/page-scraper';
import { WorkersAiTagGenerator, type TagGenerator } from './services/tag-generator';
import { WorkersAiCategoryClassifier, type CategoryClassifier } from './services/category-classifier';
import { WorkersAiCategoryReorganizer, type CategoryReorganizer } from './services/category-reorganizer';
import { WorkersAiSearchQueryExpander, type SearchQueryExpander } from './services/search-query-expander';
import { BookmarkIngestionPipeline } from './services/bookmark-ingestion-pipeline';

/**
 * The composition root: the one place concrete implementations get wired to
 * their abstractions. Route handlers only ever see the interfaces below, via
 * `c.get('deps')` — this is the only file that knows D1/Workers AI/Browser
 * Rendering are the implementations behind them.
 */
export interface Dependencies {
  repository: BookmarkRepository;
  pipeline: BookmarkIngestionPipeline;
  categoryReorganizer: CategoryReorganizer;
  searchQueryExpander: SearchQueryExpander;
}

export function buildDependencies(env: Env): Dependencies {
  const repository: BookmarkRepository = new D1BookmarkRepository(env.DB);
  const scraper: PageScraper = new BrowserRenderingScraper(env.BROWSER);
  const tagger: TagGenerator = new WorkersAiTagGenerator(env.AI);
  const categoryClassifier: CategoryClassifier = new WorkersAiCategoryClassifier(env.AI);
  const categoryReorganizer: CategoryReorganizer = new WorkersAiCategoryReorganizer(env.AI);
  const searchQueryExpander: SearchQueryExpander = new WorkersAiSearchQueryExpander(env.AI);
  const pipeline = new BookmarkIngestionPipeline(repository, scraper, tagger, categoryClassifier);

  return { repository, pipeline, categoryReorganizer, searchQueryExpander };
}
