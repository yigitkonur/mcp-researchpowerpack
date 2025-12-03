import { z } from 'zod';

// Keyword schema with validation
const keywordSchema = z
  .string({ required_error: 'web_search: Keyword is required' })
  .min(1, { message: 'web_search: Keyword cannot be empty' })
  .max(500, { message: 'web_search: Keyword too long (max 500 characters)' })
  .refine(
    k => k.trim().length > 0,
    { message: 'web_search: Keyword cannot be whitespace only' }
  );

// Input schema for web_search tool
const keywordsSchema = z
  .array(keywordSchema, {
    required_error: 'web_search: Keywords array is required',
    invalid_type_error: 'web_search: Keywords must be an array'
  })
  .min(1, { message: 'web_search: At least 1 keyword is required' })
  .max(100, { message: 'web_search: Maximum 100 keywords allowed per request' })
  .describe('Array of search keywords (1-100 keywords). Recommend 3-7 keywords for comprehensive research. Supports Google search operators (site:, -exclusion, "exact phrase", filetype:). More keywords = broader coverage and diverse perspectives.');

const webSearchParamsShape = {
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
    errorCode?: string; // MCP error code for programmatic handling (on failure)
  };
}
