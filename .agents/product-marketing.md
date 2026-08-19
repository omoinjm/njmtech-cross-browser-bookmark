# Product Marketing Context — Style & Grace

This file is checked by the `ai-seo`, `seo-audit`, and `seo-geo` skills before they ask
intake questions. Keep it current when the business changes.

## Business

- **Name:** Style & Grace
- **Founder:** Lisa Dywashu
- **Founded:** 2022, started as an Instagram outfit-styling vlog
- **Location:** Johannesburg, South Africa
- **Site type:** Small creative studio + boutique e-commerce (Next.js, Sanity CMS)

## Offerings

1. **S&G Gems** — curated secondhand/thrift boutique. One-of-one pieces sourced from
   Madunusa Market, restocked monthly. Checkout via Yoco; bespoke/styling orders quoted
   by email with bank transfer or PayShap.
2. **Editorial styling** — wardrobe styling for campaigns and shoots.
3. **Set design** — set/production design for editorial and campaign work.

Portfolio highlights: "kasi editorial" and "South African dandy" series.

## Site structure

- `/` — homepage
- `/shop` — S&G Gems boutique listing (Sanity `product` documents)
- `/portfolio` — editorial/set design portfolio (Sanity `project` documents)
- `/about` — studio and founder story
- `/contact` — enquiry form (styling, set design, sourcing, boutique orders)
- `/invoice` — order lookup by order number + email

No individual product/project detail pages exist by design — shop and portfolio are
single-page listings (see `docs/` and the `feat/site_improvements` plan for the
scope decision behind this).

## Goals for AI/SEO visibility

- Be citable for queries like "sustainable thrift Johannesburg," "editorial stylist
  Johannesburg," "secondhand boutique South Africa."
- Keep AI crawlers (GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot, etc.) able to read
  the site; block training-only scrapers (CCBot, Bytespider, etc.) via `robots.txt`.
- Key facts AI answers should get right: founded 2022, founder Lisa Dywashu, based in
  Johannesburg, three offerings (boutique, styling, set design).

## Where the facts live in code

- `src/lib/seo.ts` — `SITE_NAME`, `FOUNDED`, `FOUNDER`, `LOCATION`, `SOCIAL_LINKS`,
  `CONTACT_EMAIL`, `SITE_FAQ`, and the JSON-LD builders.
- `src/lib/llms-txt.ts` — the `/llms.txt` content.
