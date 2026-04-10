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
        .describe('A Reddit search query. Do NOT add "site:reddit.com" — it is appended automatically.'),
    )
    .min(1, { message: 'search-reddit: At least 1 query is required' })
    .max(50, { message: 'search-reddit: Maximum 50 queries allowed' })
    .describe('Array of 1-50 search queries. Each query gets "site:reddit.com" appended and is sent to Serper as a standard Google search. Returns a flat list of deduplicated Reddit URLs. Use with get-reddit-post to fetch full content and extract insights.'),
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
        .describe('A full Reddit post URL (e.g., "https://www.reddit.com/r/subreddit/comments/id/title/").'),
    )
    .min(1, { message: 'get-reddit-post: At least 1 Reddit post URL is required' })
    .max(50, { message: 'get-reddit-post: Maximum 50 Reddit post URLs allowed' })
    .describe('Array of 1-50 Reddit post URLs. Each post is fetched with full comment trees, then the LLM extracts insights per what_to_extract. Best used after search-reddit.'),
  fetch_comments: z
    .boolean()
    .default(true)
    .describe('Fetch threaded comment trees for each post. Defaults to true. Comments include author, score, OP markers, and nested replies. Set false only when you need post titles/selftext without community discussion.'),
  what_to_extract: z
    .string({ error: 'get-reddit-post: what_to_extract is required' })
    .min(5, { message: 'get-reddit-post: what_to_extract must be at least 5 characters' })
    .max(1000, { message: 'get-reddit-post: what_to_extract is too long (max 1000 characters)' })
    .describe('REQUIRED. Extraction instructions for the LLM. Describes what insights, opinions, or data to pull from each post and its comments. Use pipe separators for multiple targets: "Extract recommendations | pain points | consensus on best practices | specific tools mentioned".'),
}).strict();

export type GetRedditPostParams = z.infer<typeof getRedditPostParamsSchema>;

// ============================================================================
// search-reddit — output schema
// ============================================================================

export const searchRedditOutputSchema = z.object({
  content: z
    .string()
    .describe('Newline-separated list of unique Reddit URLs discovered across all queries.'),
  metadata: z.object({
    query_count: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of queries executed.'),
    total_urls: z
      .number()
      .int()
      .nonnegative()
      .describe('Total unique Reddit URLs returned.'),
  }).strict().describe('Metadata about the Reddit URL search.'),
}).strict();

export type SearchRedditOutput = z.infer<typeof searchRedditOutputSchema>;

// ============================================================================
// get-reddit-post — output schema
// ============================================================================

export const getRedditPostOutputSchema = z.object({
  content: z
    .string()
    .describe('LLM-synthesized extraction from Reddit posts and comments, structured per what_to_extract instructions.'),
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
    total_words_used: z
      .number()
      .int()
      .nonnegative()
      .describe('Total words used across all posts.'),
    llm_failures: z
      .number()
      .int()
      .nonnegative()
      .describe('Count of posts where LLM extraction failed (raw content returned instead).'),
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
  }).strict().describe('Metadata about the Reddit post fetch and extraction.'),
}).strict();

export type GetRedditPostOutput = z.infer<typeof getRedditPostOutputSchema>;
