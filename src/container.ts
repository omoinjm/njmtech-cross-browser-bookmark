import type { Env } from './env';
import { D1BookmarkRepository, type BookmarkRepository } from './repositories/bookmark-repository';
import { D1UserRepository, type UserRepository } from './repositories/user-repository';
import { D1SessionRepository, type SessionRepository } from './repositories/session-repository';
import { BrowserRenderingScraper, type PageScraper } from './services/page-scraper';
import { WorkersAiTagGenerator, type TagGenerator } from './services/tag-generator';
import { WorkersAiCategoryClassifier, type CategoryClassifier } from './services/category-classifier';
import { WorkersAiCategoryReorganizer, type CategoryReorganizer } from './services/category-reorganizer';
import { WorkersAiSearchQueryExpander, type SearchQueryExpander } from './services/search-query-expander';
import { WebCryptoTokenCipher, type TokenCipher } from './services/token-cipher';
import { GoogleOAuthProvider } from './services/oauth/google-oauth';
import { MicrosoftOAuthProvider } from './services/oauth/microsoft-oauth';
import type { OAuthProvider } from './services/oauth/oauth-provider';
import { WorkersAiEmbeddingGenerator, type EmbeddingGenerator } from './services/embedding-generator';
import { VectorizeSemanticIndex, type SemanticIndex } from './services/semantic-index';
import { BookmarkIngestionPipeline } from './services/bookmark-ingestion-pipeline';

/**
 * The composition root: the one place concrete implementations get wired to
 * their abstractions. Route handlers only ever see the interfaces below, via
 * `c.get('deps')` — this is the only file that knows D1/Workers AI/Browser
 * Rendering/Google/Microsoft are the implementations behind them.
 */
export interface Dependencies {
  repository: BookmarkRepository;
  pipeline: BookmarkIngestionPipeline;
  categoryReorganizer: CategoryReorganizer;
  searchQueryExpander: SearchQueryExpander;
  embeddingGenerator: EmbeddingGenerator;
  semanticIndex: SemanticIndex;
  userRepository: UserRepository;
  sessionRepository: SessionRepository;
  tokenCipher: TokenCipher;
  googleOAuth: OAuthProvider;
  microsoftOAuth: OAuthProvider;
}

export function buildDependencies(env: Env): Dependencies {
  const repository: BookmarkRepository = new D1BookmarkRepository(env.DB);
  const scraper: PageScraper = new BrowserRenderingScraper(env.BROWSER);
  const tagger: TagGenerator = new WorkersAiTagGenerator(env.AI);
  const categoryClassifier: CategoryClassifier = new WorkersAiCategoryClassifier(env.AI);
  const categoryReorganizer: CategoryReorganizer = new WorkersAiCategoryReorganizer(env.AI);
  const searchQueryExpander: SearchQueryExpander = new WorkersAiSearchQueryExpander(env.AI);
  const embeddingGenerator: EmbeddingGenerator = new WorkersAiEmbeddingGenerator(env.AI);
  const semanticIndex: SemanticIndex = new VectorizeSemanticIndex(env.VECTORIZE);
  const pipeline = new BookmarkIngestionPipeline(
    repository,
    scraper,
    tagger,
    categoryClassifier,
    embeddingGenerator,
    semanticIndex
  );

  const userRepository: UserRepository = new D1UserRepository(env.DB);
  const sessionRepository: SessionRepository = new D1SessionRepository(env.DB);
  const tokenCipher: TokenCipher = new WebCryptoTokenCipher(env.TOKEN_ENCRYPTION_KEY);
  const googleOAuth: OAuthProvider = new GoogleOAuthProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  const microsoftOAuth: OAuthProvider = new MicrosoftOAuthProvider(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET);

  return {
    repository,
    pipeline,
    categoryReorganizer,
    searchQueryExpander,
    embeddingGenerator,
    semanticIndex,
    userRepository,
    sessionRepository,
    tokenCipher,
    googleOAuth,
    microsoftOAuth,
  };
}
