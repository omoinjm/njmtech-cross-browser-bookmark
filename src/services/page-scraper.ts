import puppeteer from '@cloudflare/puppeteer';
import { MAX_TITLE_CHARS } from '../lib/validation';

export interface ScrapedPage {
  title: string;
  bodyText: string;
}

/**
 * Fetches a rendered page's title/body text. Route/pipeline code depends on
 * this interface, not on @cloudflare/puppeteer or the BROWSER binding
 * directly — a different rendering backend just means a new implementation.
 */
export interface PageScraper {
  scrape(url: string): Promise<ScrapedPage>;
}

// Cap how much scraped text we persist / send to the model. Full page text
// isn't needed for tagging or search snippets, and keeping this bounded
// controls both D1 row size and Workers AI prompt cost.
const MAX_BODY_TEXT_CHARS = 4000;

export class BrowserRenderingScraper implements PageScraper {
  constructor(private readonly browser: Fetcher) {}

  async scrape(url: string): Promise<ScrapedPage> {
    const browser = await puppeteer.launch(this.browser);

    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });

      const rawTitle = await page.title();
      const rawBodyText = await page.evaluate(() => document.body?.innerText ?? '');

      return {
        // A page's <title> is normally short, but nothing stops a
        // pathological page from serving a multi-megabyte one — bound it
        // before it reaches D1 or the tagging prompt.
        title: rawTitle.trim().slice(0, MAX_TITLE_CHARS),
        bodyText: rawBodyText.trim().slice(0, MAX_BODY_TEXT_CHARS),
      };
    } finally {
      // Browser Rendering sessions are billed while open — always release it,
      // success or failure.
      await browser.close().catch(() => {});
    }
  }
}
