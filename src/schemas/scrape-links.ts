import { z } from 'zod';

const urlSchema = z
  .string({ required_error: 'scrape_pages: URL is required' })
  .url({ message: 'scrape_pages: Invalid URL format' })
  .refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    { message: 'scrape_pages: URL must use http:// or https:// protocol' }
  );

// Input schema for scrape_pages tool
const scrapeLinksParamsShape = {
  urls: z
    .array(urlSchema, {
      required_error: 'scrape_pages: URLs array is required',
      invalid_type_error: 'scrape_pages: URLs must be an array'
    })
    .min(1, { message: 'scrape_pages: At least 1 URL is required' })
    .max(50, { message: 'scrape_pages: Maximum 50 URLs allowed per request' })
    .describe('URLs to scrape (1-50; 3-5 recommended). More URLs broaden coverage but reduce per-URL extraction budget.'),
  timeout: z
    .number({ invalid_type_error: 'scrape_pages: Timeout must be a number' })
    .min(5, { message: 'scrape_pages: Timeout must be at least 5 seconds' })
    .max(120, { message: 'scrape_pages: Timeout cannot exceed 120 seconds' })
    .default(30)
    .describe('Timeout in seconds for each URL'),
  use_llm: z
    .boolean({ invalid_type_error: 'scrape_pages: use_llm must be a boolean' })
    .default(true)
    .describe('Enable LLM extraction post-processing (default true). When enabled, strict MUST-DO formatting rules apply (concise+comprehensive, table/list routing). Set false for mostly raw cleaned content, lower latency/cost, or when LLM extraction is unavailable.'),
  what_to_extract: z
    .string()
    .max(1000, { message: 'scrape_pages: Extraction instructions too long (max 1000 characters)' })
    .optional()
    .describe('Extraction targets/focus. Prefer compact, specific targets (pipe-separated works well), e.g. "pricing tiers|limits|auth flows with focus on free tier and rate limits". You may request output style: markdown tables or nested lists (max depth 5).'),
  model: z
    .enum(['openai/gpt-oss-120b:nitro', 'x-ai/grok-4.1-fast'], {
      errorMap: () => ({ message: 'scrape_pages: model must be "openai/gpt-oss-120b:nitro" or "x-ai/grok-4.1-fast"' }),
    })
    .optional()
    .describe('Override the LLM extraction model for this request. Allowed: "openai/gpt-oss-120b:nitro" (default, best for extraction) or "x-ai/grok-4.1-fast" (adds web search). Default: openai/gpt-oss-120b:nitro.'),
};

export const scrapeLinksParamsSchema = z.object(scrapeLinksParamsShape);
export type ScrapeLinksParams = z.infer<typeof scrapeLinksParamsSchema>;

export interface ScrapeLinksOutput {
  content: string;
  metadata: {
    total_urls: number;
    successful: number;
    failed: number;
    total_credits: number;
    execution_time_ms: number;
    tokens_per_url?: number;
    total_token_budget?: number;
    batches_processed?: number;
  };
}
