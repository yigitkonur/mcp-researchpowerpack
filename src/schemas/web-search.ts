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
  .describe('A single Google search query (1–500 chars). Each keyword runs as a separate parallel search. Use varied angles: direct topic, comparisons, "best of" lists, year-specific, site-specific (e.g., "site:github.com topic").');

// Input schema for web-search tool
const keywordsSchema = z
  .array(keywordSchema, {
    error: 'web-search: Keywords must be an array',
  })
  .min(1, { message: 'web-search: At least 1 keyword required' })
  .max(100, { message: 'web-search: Maximum 100 keywords allowed per request' })
  .describe('Array of 1–100 search keywords. RECOMMENDED: 3–7 for solid consensus ranking, up to 20 for thorough coverage. Each keyword runs as a separate Google search in parallel. Results are aggregated and URLs appearing in multiple searches are flagged as high-confidence consensus matches. Supply <1 and you get an error; >100 is rejected.');

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
    coverage_summary: z
      .array(z.object({
        keyword: z.string().describe('The search keyword.'),
        result_count: z.number().int().nonnegative().describe('Number of results returned for this keyword.'),
        top_url: z.string().optional().describe('Domain of the top-ranked result for this keyword.'),
      }))
      .optional()
      .describe('Per-keyword result counts and top URLs for coverage analysis.'),
    low_yield_keywords: z
      .array(z.string())
      .optional()
      .describe('Keywords that produced 0-1 results.'),
  }).strict().describe('Structured metadata about the completed web search batch.'),
}).strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
