import { z } from 'zod';

// Input schema for web_search tool (renamed from search_multiple)
const keywordsSchema = z
  .array(z.string().min(1, 'Keyword cannot be empty').max(500, 'Keyword cannot exceed 500 characters'))
  .min(1, 'At least one keyword is required')
  .max(100, 'Cannot exceed 100 keywords per request')
  .describe('Array of search keywords (1-100 keywords). Recommend 3-7 keywords for comprehensive research. Use specific, targeted keywords for best results. More keywords = broader coverage and diverse perspectives.');

export const webSearchParamsShape = {
  keywords: keywordsSchema,
};

export const webSearchParamsSchema = z.object(webSearchParamsShape);
export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

// Output type
export interface WebSearchOutput {
  content: string;
  metadata: {
    total_keywords: number;
    total_results: number;
    execution_time_ms: number;
    total_unique_urls?: number;
    consensus_url_count?: number;
    frequency_threshold?: number;
  };
}
