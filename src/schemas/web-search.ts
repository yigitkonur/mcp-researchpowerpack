import { z } from 'zod';

// Keyword schema with validation
const keywordSchema = z
  .string({ error: 'web-search: Keyword is required' })
  .min(1, { message: 'web-search: Keyword cannot be empty' })
  .max(500, { message: 'web-search: Keyword too long (max 500 characters)' })
  .refine(
    k => k.trim().length > 0,
    { message: 'web-search: Keyword cannot be whitespace only' }
  )
  .describe('A single web search keyword or query phrase covering one angle of the topic.');

// Input schema for web-search tool
const keywordsSchema = z
  .array(keywordSchema, {
    error: 'web-search: Keywords must be an array',
  })
  .min(1, { message: 'web-search: At least 1 keyword required' })
  .max(100, { message: 'web-search: Maximum 100 keywords allowed per request' })
  .describe('Array of search keywords (1-100, RECOMMENDED 3-7 for consensus ranking). Each keyword runs as a separate Google search in parallel. More keywords = better consensus detection across results.');

const webSearchParamsShape = {
  keywords: keywordsSchema,
};

export const webSearchParamsSchema = z.object(webSearchParamsShape).strict();
export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

export const webSearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Formatted markdown report containing ranked URLs with consensus markers and per-query results.'),
  metadata: z.object({
    total_keywords: z
      .number()
      .int()
      .nonnegative()
      .describe('Total number of keyword queries executed.'),
    total_results: z
      .number()
      .int()
      .nonnegative()
      .describe('Total number of ranked search results included across shown queries.'),
    execution_time_ms: z
      .number()
      .int()
      .nonnegative()
      .describe('Elapsed execution time in milliseconds.'),
    total_unique_urls: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Unique URL count observed across all searches.'),
    consensus_url_count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Count of URLs that met the consensus threshold.'),
    frequency_threshold: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Minimum frequency required for a URL to be considered consensus.'),
  }).strict().describe('Structured metadata about the completed web search batch.'),
}).strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
