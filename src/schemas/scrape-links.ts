import { z } from 'zod';

// URL schema with protocol validation
const urlSchema = z
  .string({ error: 'scrape-links: URL is required' })
  .url({ message: 'scrape-links: Invalid URL format' })
  .refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    { message: 'scrape-links: URL must use http:// or https:// protocol' }
  )
  .describe('A fully-qualified HTTP or HTTPS URL to fetch and extract content from.');

// Input schema for scrape-links tool
export const scrapeLinksParamsSchema = z.object({
  urls: z
    .array(urlSchema, { error: 'scrape-links: URLs must be an array' })
    .min(1, { message: 'scrape-links: At least 1 URL is required' })
    .max(50, { message: 'scrape-links: Maximum 50 URLs allowed per request' })
    .describe('URLs to scrape (1-50). Token budget (32K) is split across URLs: 3 URLs get ~10K tokens each (deep), 10 get ~3K (balanced), 50 get ~640 (scan). Each page is scraped, cleaned, and processed by the LLM per what_to_extract.'),
  timeout: z
    .number({ error: 'scrape-links: Timeout must be a number' })
    .min(5, { message: 'scrape-links: Timeout must be at least 5 seconds' })
    .max(120, { message: 'scrape-links: Timeout cannot exceed 120 seconds' })
    .default(30)
    .describe('Timeout in seconds for each URL.'),
  what_to_extract: z
    .string({ error: 'scrape-links: what_to_extract is required' })
    .min(5, { message: 'scrape-links: what_to_extract must be at least 5 characters' })
    .max(1000, { message: 'scrape-links: Extraction instructions too long (max 1000 characters)' })
    .describe('REQUIRED. Extraction instructions for the LLM. The LLM processes each scraped page and extracts ONLY what you specify. Formula: "Extract [target1] | [target2] | [target3] with focus on [aspect]". Be specific: "pricing tiers | monthly vs annual cost | free tier limits" not just "pricing".'),
}).strict();

export type ScrapeLinksParams = z.infer<typeof scrapeLinksParamsSchema>;

export const scrapeLinksOutputSchema = z.object({
  content: z
    .string()
    .describe('LLM-extracted content from scraped pages, structured per what_to_extract instructions.'),
  metadata: z.object({
    total_urls: z
      .number()
      .int()
      .nonnegative()
      .describe('Total number of input URLs processed.'),
    successful: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of URLs that were fetched successfully.'),
    failed: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of URLs that failed validation or scraping.'),
    total_credits: z
      .number()
      .int()
      .nonnegative()
      .describe('Total external scraping credits consumed.'),
    execution_time_ms: z
      .number()
      .int()
      .nonnegative()
      .describe('Elapsed execution time in milliseconds.'),
    tokens_per_url: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Allocated LLM token budget per successfully scraped URL.'),
    total_token_budget: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Overall token budget available for extraction.'),
    batches_processed: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of scrape batches executed.'),
  }).strict().describe('Structured metadata about the scrape and extraction batch.'),
}).strict();

export type ScrapeLinksOutput = z.infer<typeof scrapeLinksOutputSchema>;
