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
  .describe('A single Google search query (1-500 chars). Each keyword runs as a separate parallel search. Use varied angles: direct topic, comparisons, "best of" lists, year-specific, site-specific (e.g., "site:github.com topic").');

// Input schema for web-search tool
export const webSearchParamsSchema = z.object({
  keywords: z
    .array(keywordSchema, { error: 'web-search: Keywords must be an array' })
    .min(1, { message: 'web-search: At least 1 keyword required' })
    .max(100, { message: 'web-search: Maximum 100 keywords allowed per request' })
    .describe('Array of 1-100 search keywords. Each runs as a separate Google search in parallel. Results are aggregated, deduplicated, and ranked by CTR-weighted consensus. RECOMMENDED: 3-7 keywords for solid consensus, up to 20 for thorough coverage.'),
  objective: z
    .string({ error: 'web-search: objective is required' })
    .min(5, { message: 'web-search: objective must be at least 5 characters' })
    .max(500, { message: 'web-search: objective too long (max 500 characters)' })
    .describe('REQUIRED. Describes what you are looking for. An LLM classifies each search result into 3 relevance tiers (highly relevant, maybe relevant, other) using only titles, snippets, and site names — no URLs are fetched. Be specific: "open-source MCP server implementations in TypeScript" not "MCP servers". Also generates a synthesis paragraph summarizing key findings.'),
  raw: z
    .boolean({ error: 'web-search: raw must be a boolean' })
    .default(false)
    .describe('When true, skip LLM classification and return the traditional CTR-weighted consensus-ranked URL list. Use when you need raw context or the LLM endpoint is unavailable. Default: false (LLM classification enabled).'),
}).strict();

export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

export const webSearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Markdown report. With LLM: 3-tier table (highly relevant / maybe relevant / other) with synthesis. With raw=true: traditional CTR-ranked list.'),
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
      .describe('Total unique URLs found across all searches.'),
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
    llm_classified: z
      .boolean()
      .describe('Whether LLM classification was applied to the results.'),
    llm_error: z
      .string()
      .optional()
      .describe('LLM classification error message if classification failed and fell back to raw output.'),
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
