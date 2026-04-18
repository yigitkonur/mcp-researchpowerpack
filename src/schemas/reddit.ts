import { z } from 'zod';

// Note: search-reddit was deleted in mcp-revisions/tool-surface/01.
// Reddit discovery now flows through `web-search` with `scope: "reddit"`.
// See src/schemas/web-search.ts for the scope param.

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
