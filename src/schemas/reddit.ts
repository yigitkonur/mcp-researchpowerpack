import { z } from 'zod';

// ============================================================================
// search-reddit — input schema
// ============================================================================

export const searchRedditParamsSchema = z.object({
  queries: z
    .array(
      z
        .string()
        .min(1, { message: 'search-reddit: Query cannot be empty' })
        .describe('A single Reddit search query targeting one specific angle (e.g., "MCP server best practices", "r/ClaudeAI MCP setup guide", "MCP vs REST 2025"). Keep each query focused on one facet.'),
    )
    .min(1, { message: 'search-reddit: At least 1 query is required' })
    .max(50, { message: 'search-reddit: Maximum 50 queries allowed' })
    .describe(
      'Array of 1–50 Reddit search queries. RECOMMENDED: 3–7 for solid consensus ranking (results are aggregated across queries and URLs appearing in multiple searches are flagged as high-confidence). Each query should target a different angle: direct topic, "best of" lists, comparisons, pain points, subreddit-specific (e.g., "r/programming topic"), or year-specific. Single-query lookups work but produce no consensus signal. More queries = better signal-to-noise.',
    ),
  date_after: z
    .string()
    .optional()
    .describe('Optional lower date bound in YYYY-MM-DD format.'),
}).strict();

export type SearchRedditParams = z.infer<typeof searchRedditParamsSchema>;

// ============================================================================
// get-reddit-post — input schema
// ============================================================================

export const getRedditPostParamsSchema = z.object({
  urls: z
    .array(
      z
        .string()
        .url({ message: 'get-reddit-post: Each URL must be valid' })
        .describe('A full Reddit post URL (e.g., "https://www.reddit.com/r/subreddit/comments/id/title/"). Must be a valid URL pointing to a Reddit post. Typically sourced from search-reddit results.'),
    )
    .min(1, { message: 'get-reddit-post: At least 1 Reddit post URL is required' })
    .max(50, { message: 'get-reddit-post: Maximum 50 Reddit post URLs allowed' })
    .describe('Array of 1–50 Reddit post URLs. RECOMMENDED: 2–10 for comparative research across multiple discussions. Supply URLs from search-reddit output or any Reddit post links. Each post gets up to 20K words of threaded comments within a 100K total word budget. More URLs = broader community perspective but less depth per post.'),
  fetch_comments: z
    .boolean()
    .default(true)
    .describe('Fetch threaded comment trees for each post. Defaults to true. Comments include author, score, OP markers, and nested replies up to the word budget. Set false only when you need post titles/selftext without community discussion.'),
  use_llm: z
    .boolean()
    .default(false)
    .describe('Run AI synthesis over fetched Reddit content. Defaults to false (recommended) — raw threaded comments preserve the full community voice. Only set true when you have lots of posts and individual comments don\'t matter, e.g., scanning 20+ threads for a quick consensus summary.'),
  what_to_extract: z
    .string()
    .max(1000, { message: 'get-reddit-post: what_to_extract is too long' })
    .optional()
    .describe('Optional extraction instructions used only when use_llm=true.'),
}).strict();

export type GetRedditPostParams = z.infer<typeof getRedditPostParamsSchema>;

// ============================================================================
// search-reddit — output schema
// ============================================================================

export const searchRedditOutputSchema = z.object({
  content: z
    .string()
    .describe('Formatted markdown report containing ranked Reddit URLs and search guidance.'),
  metadata: z.object({
    query_count: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of Reddit-focused queries executed.'),
    total_results: z
      .number()
      .int()
      .nonnegative()
      .describe('Total number of Reddit search results collected before ranking.'),
    date_after: z
      .string()
      .optional()
      .describe('Applied lower date bound in YYYY-MM-DD format, when provided.'),
  }).strict().describe('Structured metadata about the Reddit search batch.'),
}).strict();

export type SearchRedditOutput = z.infer<typeof searchRedditOutputSchema>;

// ============================================================================
// get-reddit-post — output schema
// ============================================================================

export const getRedditPostOutputSchema = z.object({
  content: z
    .string()
    .describe('Formatted markdown report containing Reddit posts, comments, and next steps.'),
  metadata: z.object({
    total_urls: z
      .number()
      .int()
      .nonnegative()
      .describe('Total number of Reddit post URLs processed.'),
    successful: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of posts fetched successfully.'),
    failed: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of post fetches that failed.'),
    fetch_comments: z
      .boolean()
      .describe('Whether comments were fetched for each post.'),
    max_words_per_post: z
      .number()
      .int()
      .nonnegative()
      .describe('Word budget per post for comment output.'),
    total_words_used: z
      .number()
      .int()
      .nonnegative()
      .describe('Total words used across all posts.'),
    llm_requested: z
      .boolean()
      .describe('Whether LLM extraction was requested.'),
    llm_available: z
      .boolean()
      .describe('Whether LLM extraction was actually available at runtime.'),
    llm_failures: z
      .number()
      .int()
      .nonnegative()
      .describe('Count of posts where optional LLM extraction failed or was skipped.'),
    total_batches: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of Reddit API batches executed.'),
    rate_limit_hits: z
      .number()
      .int()
      .nonnegative()
      .describe('Observed Reddit API rate-limit retries during the batch.'),
  }).strict().describe('Structured metadata about the Reddit post fetch batch.'),
}).strict();

export type GetRedditPostOutput = z.infer<typeof getRedditPostOutputSchema>;
