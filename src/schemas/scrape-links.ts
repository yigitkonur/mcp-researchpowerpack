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
    .describe('Web page URLs to scrape and extract content from.'),
  extract: z
    .string()
    .min(1, { message: 'scrape-links: extract cannot be empty' })
    .describe('What to pull from each page. The LLM reads the scraped content and returns only what you specify. Be specific: "pricing tiers | free tier limits | enterprise contact info" not "pricing".'),
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
