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
const scrapeLinksParamsShape = {
  urls: z
    .array(urlSchema, {
      error: 'scrape-links: URLs must be an array',
    })
    .min(1, { message: 'scrape-links: At least 1 URL is required' })
    .max(50, { message: 'scrape-links: Maximum 50 URLs allowed per request' })
    .describe('URLs to scrape (1-50). Recommend 3-5 URLs for balanced depth/breadth. More URLs = broader coverage but fewer tokens per URL. 3 URLs: ~10K tokens each (deep); 10 URLs: ~3K tokens each (balanced); 50 URLs: ~640 tokens each (scan).'),
  timeout: z
    .number({ error: 'scrape-links: Timeout must be a number' })
    .min(5, { message: 'scrape-links: Timeout must be at least 5 seconds' })
    .max(120, { message: 'scrape-links: Timeout cannot exceed 120 seconds' })
    .default(30)
    .describe('Timeout in seconds for each URL'),
  use_llm: z
    .boolean({ error: 'scrape-links: use_llm must be a boolean' })
    .default(true)
    .describe('AI extraction enabled by default (requires OPENROUTER_API_KEY). Auto-filters nav/ads/footers, extracts ONLY what you specify. Set false only for raw HTML debugging.'),
  what_to_extract: z
    .string()
    .max(1000, { message: 'scrape-links: Extraction instructions too long (max 1000 characters)' })
    .optional()
    .describe('Extraction instructions for AI. Will be wrapped with compression prefix+suffix automatically. Formula: "Extract [target1] | [target2] | [target3] with focus on [aspect1], [aspect2]". Min 3 targets with | separator. Be specific (pricing tiers not pricing). Aim 5-10 targets.'),
};

export const scrapeLinksParamsSchema = z.object(scrapeLinksParamsShape).strict();
export type ScrapeLinksParams = z.infer<typeof scrapeLinksParamsSchema>;

export const scrapeLinksOutputSchema = z.object({
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
  }).strict().describe('Structured metadata about the scrape batch.'),
}).strict();

export type ScrapeLinksOutput = z.infer<typeof scrapeLinksOutputSchema>;
