import { z } from 'zod';

export const webSearchParamsSchema = z.object({
  queries: z
    .array(
      z.string()
        .min(1, { message: 'web-search: Query cannot be empty' })
        .max(500, { message: 'web-search: Query too long (max 500 chars)' })
        .describe('A single Google search query. Each query runs as a separate parallel search.'),
    )
    .min(1, { message: 'web-search: At least 1 query required' })
    .max(100, { message: 'web-search: Maximum 100 queries allowed' })
    .describe('Search queries to run in parallel via Google. More queries = broader coverage and stronger consensus signals across results.'),
  extract: z
    .string()
    .min(5, { message: 'web-search: extract must be at least 5 characters' })
    .max(500, { message: 'web-search: extract too long (max 500 chars)' })
    .describe('What you are looking for. The LLM classifies each result by relevance and generates a synthesis. Be specific: "TypeScript MCP server frameworks with OAuth support" not "MCP servers".'),
  raw: z
    .boolean()
    .default(false)
    .describe('Skip LLM classification and return the raw ranked URL list. Use when you need unprocessed results.'),
}).strict();

export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

export const webSearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Markdown report with tiered results (LLM mode) or ranked URL list (raw mode).'),
  metadata: z.object({
    total_items: z.number().int().nonnegative().describe('Number of queries executed.'),
    successful: z.number().int().nonnegative().describe('Queries that returned results.'),
    failed: z.number().int().nonnegative().describe('Queries that failed.'),
    execution_time_ms: z.number().int().nonnegative().describe('Wall clock time in milliseconds.'),
    llm_classified: z.boolean().describe('Whether LLM classification was applied.'),
    llm_error: z.string().optional().describe('LLM error if classification failed and fell back to raw.'),
    coverage_summary: z
      .array(z.object({
        query: z.string().describe('The search query.'),
        result_count: z.number().int().nonnegative().describe('Results returned for this query.'),
        top_url: z.string().optional().describe('Domain of the top result.'),
      }))
      .optional()
      .describe('Per-query result counts and top URLs.'),
    low_yield_queries: z
      .array(z.string())
      .optional()
      .describe('Queries that produced 0-1 results.'),
  }).strict(),
}).strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
