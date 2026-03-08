import { z } from 'zod';

const keywordSchema = z
  .string({ required_error: 'search_google: Keyword is required' })
  .min(1, { message: 'search_google: Keyword cannot be empty' })
  .max(500, { message: 'search_google: Keyword too long (max 500 characters)' })
  .refine(
    k => k.trim().length > 0,
    { message: 'search_google: Keyword cannot be whitespace only' }
  );

// Input schema for search_google tool
const keywordsSchema = z
  .array(keywordSchema, {
    required_error: 'search_google: Keywords array is required',
    invalid_type_error: 'search_google: Keywords must be an array'
  })
  .min(3, { message: 'search_google: You need at least 3 keywords but sent fewer. Add more diverse keywords covering different angles (e.g., broad topic, specific technical term, "topic vs alternative", "topic best practices 2025") and call search_google again immediately.' })
  .max(100, { message: 'search_google: You sent more than 100 keywords — split into 2 separate search_google calls and run them both. Each call gets its own result set, giving you even more coverage.' })
  .describe('3-100 search keywords (5-7 recommended). Each keyword runs as a separate parallel Google search; keep angles diverse for better coverage.');

const webSearchParamsShape = {
  keywords: keywordsSchema,
};

export const webSearchParamsSchema = z.object(webSearchParamsShape);
export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

export interface WebSearchOutput {
  content: string;
  metadata: {
    total_keywords: number;
    total_results: number;
    execution_time_ms: number;
    total_unique_urls?: number;
    consensus_url_count?: number;
    frequency_threshold?: number;
    errorCode?: string;
  };
}
