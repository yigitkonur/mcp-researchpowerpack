import { z } from 'zod';

// ============================================================================
// search-reddit
// ============================================================================

export const searchRedditParamsSchema = z.object({
  queries: z
    .array(
      z.string()
        .min(1, { message: 'search-reddit: Query cannot be empty' })
        .describe('A Reddit search query. "site:reddit.com" is appended automatically.'),
    )
    .min(1, { message: 'search-reddit: At least 1 query required' })
    .describe('Search queries for Reddit. Each query is automatically scoped to reddit.com via Google. Returns deduplicated Reddit post URLs.'),
}).strict();

export type SearchRedditParams = z.infer<typeof searchRedditParamsSchema>;

export const searchRedditOutputSchema = z.object({
  content: z
    .string()
    .describe('Newline-separated list of unique Reddit URLs.'),
  metadata: z.object({
    total_items: z.number().int().nonnegative().describe('Number of queries executed.'),
    successful: z.number().int().nonnegative().describe('Queries that returned results.'),
    failed: z.number().int().nonnegative().describe('Queries that failed.'),
    execution_time_ms: z.number().int().nonnegative().describe('Wall clock time in milliseconds.'),
  }).strict(),
}).strict();

export type SearchRedditOutput = z.infer<typeof searchRedditOutputSchema>;

// ============================================================================
// get-reddit-post
// ============================================================================

export const getRedditPostParamsSchema = z.object({
  urls: z
    .array(
      z.string()
        .url({ message: 'get-reddit-post: Each URL must be valid' })
        .describe('A Reddit post URL.'),
    )
    .min(1, { message: 'get-reddit-post: At least 1 URL required' })
    .describe('Reddit post URLs to fetch. Each post is returned with its full threaded comment tree.'),
}).strict();

export type GetRedditPostParams = z.infer<typeof getRedditPostParamsSchema>;

export const getRedditPostOutputSchema = z.object({
  content: z
    .string()
    .describe('Raw Reddit posts with threaded comments including author, score, and OP markers.'),
  metadata: z.object({
    total_items: z.number().int().nonnegative().describe('Number of URLs processed.'),
    successful: z.number().int().nonnegative().describe('Posts fetched successfully.'),
    failed: z.number().int().nonnegative().describe('Posts that failed to fetch.'),
    execution_time_ms: z.number().int().nonnegative().describe('Wall clock time in milliseconds.'),
    rate_limit_hits: z.number().int().nonnegative().describe('Reddit API rate-limit retries.'),
  }).strict(),
}).strict();

export type GetRedditPostOutput = z.infer<typeof getRedditPostOutputSchema>;
