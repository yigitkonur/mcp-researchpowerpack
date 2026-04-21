import { z } from 'zod';

const urlSchema = z
  .string()
  .url({ message: 'scrape-links: Invalid URL format' })
  .refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    { message: 'scrape-links: URL must use http:// or https://' }
  )
  .describe('A fully-qualified HTTP or HTTPS URL to scrape.');

export const scrapeLinksParamsSchema = z.object({
  urls: z
    .array(urlSchema)
    .min(1, { message: 'scrape-links: At least 1 URL required' })
    .describe('URLs to fetch and extract in parallel. Reddit post permalinks (`reddit.com/r/<sub>/comments/<id>/...`) are auto-detected and routed through the Reddit API (threaded post + comments); every other URL flows through the HTTP scraper. Mix reddit + non-reddit URLs freely; both branches run concurrently. Prefer contextually grouped batches — call this tool multiple times in parallel when URL sets are unrelated, instead of one giant mixed batch.'),
  extract: z
    .string()
    .min(1, { message: 'scrape-links: extract cannot be empty' })
    .describe(
      'Semantic extraction instruction. Describe the SHAPE of what you want, separated by `|`. The extractor classifies each page (docs / github-thread / reddit / marketing / cve / paper / announcement / qa / blog / changelog / release-notes) and adjusts emphasis per type: preserves numbers/versions/stacktraces verbatim from docs and CVE pages, quotes Reddit/HN with attribution plus sentiment distribution, flags what the page did NOT answer in a "Not found" section, and surfaces referenced-but-unscraped URLs in a "Follow-up signals" bulletin that feeds the next research loop. Good examples: "root cause | affected versions | fix | workarounds | timeline"; "pricing tiers | rate limits | enterprise contact | free-tier quotas"; "maintainer decisions | accepted fix commits | stacktraces | resolved version".',
    ),
}).strict();

export type ScrapeLinksParams = z.infer<typeof scrapeLinksParamsSchema>;

export const scrapeLinksOutputSchema = z.object({
  content: z
    .string()
    .describe('LLM-extracted content from scraped pages per the extract instructions.'),
  metadata: z.object({
    total_items: z.number().int().nonnegative().describe('Number of URLs processed.'),
    successful: z.number().int().nonnegative().describe('URLs fetched successfully.'),
    failed: z.number().int().nonnegative().describe('URLs that failed.'),
    execution_time_ms: z.number().int().nonnegative().describe('Wall clock time in milliseconds.'),
    total_credits: z.number().int().nonnegative().describe('External scraping credits consumed.'),
  }).strict(),
}).strict();

export type ScrapeLinksOutput = z.infer<typeof scrapeLinksOutputSchema>;
