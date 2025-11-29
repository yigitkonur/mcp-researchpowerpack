import { z } from 'zod';

// Input schema for scrape_links tool
export const scrapeLinksParamsShape = {
  urls: z
    .array(z.string().url('Must be a valid HTTP or HTTPS URL'))
    .min(1, 'At least one URL required')
    .max(50, 'Maximum 50 URLs allowed per request')
    .describe('URLs to scrape (1-50). Recommend 3-5 URLs for balanced depth/breadth. More URLs = broader coverage but fewer tokens per URL. 3 URLs: ~10K tokens each (deep); 10 URLs: ~3K tokens each (balanced); 50 URLs: ~640 tokens each (scan).'),
  timeout: z
    .number()
    .min(5)
    .max(120)
    .default(30)
    .describe('Timeout in seconds for each URL'),
  use_llm: z
    .boolean()
    .default(false)
    .describe('Enable AI processing for content extraction (requires OPENROUTER_API_KEY)'),
  what_to_extract: z
    .string()
    .max(1000)
    .optional()
    .describe('Specific content extraction instructions for AI. Will be enhanced with conciseness suffix automatically.'),
};

export const scrapeLinksParamsSchema = z.object(scrapeLinksParamsShape);
export type ScrapeLinksParams = z.infer<typeof scrapeLinksParamsSchema>;

// Output type
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
