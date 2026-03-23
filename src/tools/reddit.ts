/**
 * Reddit Tools - Search and Fetch
 * NEVER throws - always returns structured response for graceful degradation
 */

import type { MCPServer } from 'mcp-use/server';
import { z } from 'zod';

import { SearchClient } from '../clients/search.js';
import { RedditClient, calculateCommentAllocation, type PostResult, type Comment } from '../clients/reddit.js';
import { aggregateAndRankReddit, generateRedditEnhancedOutput } from '../utils/url-aggregator.js';
import { REDDIT, getCapabilities, getMissingEnvMessage, parseEnv } from '../config/index.js';
import { classifyError } from '../utils/errors.js';
import { createLLMProcessor, processContentWithLLM } from '../services/llm-processor.js';
import { pMap } from '../utils/concurrency.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  TOKEN_BUDGETS,
} from './utils.js';
import {
  createToolReporter,
  NOOP_REPORTER,
  toolFailure,
  toolSuccess,
  toToolResponse,
  type ToolExecutionResult,
  type ToolReporter,
} from './mcp-helpers.js';

// ============================================================================
// Formatters
// ============================================================================

export const searchRedditParamsSchema = z.object({
  queries: z
    .array(
      z
        .string()
        .min(1, { message: 'search-reddit: Query cannot be empty' })
        .describe('A single Reddit-focused search query targeting one specific angle.'),
    )
    .min(3, { message: 'search-reddit: Minimum 3 diverse queries required' })
    .max(50, { message: 'search-reddit: Maximum 50 queries allowed' })
    .describe(
      '3-50 diverse Reddit queries. Each query should target a different angle such as direct topic, best-of lists, comparisons, issues, subreddit targeting, or year-specific searches.',
    ),
  date_after: z
    .string()
    .optional()
    .describe('Optional lower date bound in YYYY-MM-DD format.'),
}).strict();

export const getRedditPostParamsSchema = z.object({
  urls: z
    .array(
      z
        .string()
        .url({ message: 'get-reddit-post: Each URL must be valid' })
        .describe('A Reddit post URL returned from search-reddit or another source.'),
    )
    .min(2, { message: 'get-reddit-post: Minimum 2 Reddit post URLs required' })
    .max(50, { message: 'get-reddit-post: Maximum 50 Reddit post URLs allowed' })
    .describe('2-50 Reddit post URLs. More URLs improve consensus and breadth.'),
  fetch_comments: z
    .boolean()
    .default(true)
    .describe('Whether to fetch Reddit comments. Keep true unless only titles/selftext are needed.'),
  max_comments: z
    .number()
    .int()
    .min(1, { message: 'get-reddit-post: max_comments must be at least 1' })
    .max(1000, { message: 'get-reddit-post: max_comments cannot exceed 1000' })
    .default(100)
    .describe('Optional comment budget override across the fetched posts.'),
  use_llm: z
    .boolean()
    .default(false)
    .describe('Whether to run AI synthesis over fetched Reddit content. Defaults to false to preserve raw comments.'),
  what_to_extract: z
    .string()
    .max(1000, { message: 'get-reddit-post: what_to_extract is too long' })
    .optional()
    .describe('Optional extraction instructions used only when use_llm=true.'),
}).strict();

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

type SearchRedditOutput = z.infer<typeof searchRedditOutputSchema>;

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
    comments_per_post: z
      .number()
      .int()
      .nonnegative()
      .describe('Allocated comment budget per post.'),
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

type GetRedditPostOutput = z.infer<typeof getRedditPostOutputSchema>;

function formatComments(comments: Comment[]): string {
  let md = '';
  for (const c of comments) {
    const indent = '  '.repeat(c.depth);
    const op = c.isOP ? ' **[OP]**' : '';
    const score = c.score >= 0 ? `+${c.score}` : `${c.score}`;
    md += `${indent}- **u/${c.author}**${op} _(${score})_\n`;
    const bodyLines = c.body.split('\n').map(line => `${indent}  ${line}`).join('\n');
    md += `${bodyLines}\n\n`;
  }
  return md;
}

function formatPost(result: PostResult, fetchComments: boolean): string {
  const { post, comments, allocatedComments } = result;
  let md = `## ${post.title}\n\n`;
  md += `**r/${post.subreddit}** • u/${post.author} • ⬆️ ${post.score} • 💬 ${post.commentCount} comments\n`;
  md += `🔗 ${post.url}\n\n`;

  if (post.body) {
    md += `### Post Content\n\n${post.body}\n\n`;
  }

  if (fetchComments && comments.length > 0) {
    md += `### Top Comments (${comments.length}/${post.commentCount} shown, allocated: ${allocatedComments})\n\n`;
    md += formatComments(comments);
  } else if (!fetchComments) {
    md += `_Comments not fetched (fetch_comments=false)_\n\n`;
  }

  return md;
}

// ============================================================================
// Search Reddit Handler
// ============================================================================

function countTotalResults(results: Map<string, unknown[]>): number {
  let total = 0;
  for (const items of results.values()) {
    total += items.length;
  }
  return total;
}

function formatNoSearchResults(queryCount: number): string {
  return formatError({
    code: 'NO_RESULTS',
    message: `No results found for any of the ${queryCount} queries`,
    toolName: 'search-reddit',
    howToFix: [
      'Try broader or simpler search terms',
      'Check spelling of technical terms',
      'Remove date filters if using them',
    ],
    alternatives: [
      'web-search(keywords=["topic best practices", "topic guide", "topic recommendations 2025"]) — get results from the broader web instead',
      'scrape-links(urls=[...any URLs you already have...], use_llm=true) — if you have URLs from earlier searches, scrape them now',
      'deep-research(questions=[{question: "What are the key findings about [topic]?"}]) — synthesize from AI research',
    ],
  });
}

function formatSearchRedditError(error: unknown): string {
  const structuredError = classifyError(error);
  return formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'search-reddit',
    howToFix: ['Verify SERPER_API_KEY is set correctly'],
    alternatives: [
      'web-search(keywords=["topic recommendations", "topic best practices", "topic vs alternatives"]) — uses the same API key, but try anyway as it may work for general search',
      'deep-research(questions=[{question: "What does the community recommend for [topic]?"}]) — uses a different API (OpenRouter), not affected by this error',
      'scrape-links(urls=[...any URLs you already have...], use_llm=true) — if you have URLs from prior steps, scrape them now',
    ],
  });
}

export async function handleSearchReddit(
  queries: string[],
  apiKey: string,
  dateAfter?: string,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<SearchRedditOutput>> {
  try {
    const limited = queries.slice(0, 50);
    const client = new SearchClient(apiKey);
    await reporter.log('info', `Running ${limited.length} Reddit search query/queries`);
    await reporter.progress(15, 100, 'Submitting Reddit search queries');
    const results = await client.searchRedditMultiple(limited, dateAfter);

    const totalResults = countTotalResults(results);
    if (totalResults === 0) {
      return toolFailure(formatNoSearchResults(limited.length));
    }

    await reporter.progress(60, 100, 'Collected Reddit search results');
    const aggregation = aggregateAndRankReddit(results, 3);
    const content = generateRedditEnhancedOutput(aggregation, limited, results);
    await reporter.log('info', `Collected ${totalResults} Reddit results across ${limited.length} queries`);
    await reporter.progress(85, 100, 'Ranking Reddit results');
    return toolSuccess(content, {
      content,
      metadata: {
        query_count: limited.length,
        total_results: totalResults,
        ...(dateAfter ? { date_after: dateAfter } : {}),
      },
    });
  } catch (error) {
    return toolFailure(formatSearchRedditError(error));
  }
}

// ============================================================================
// Get Reddit Posts Handler
// ============================================================================

interface GetRedditPostsOptions {
  fetchComments?: boolean;
  maxCommentsOverride?: number;
  use_llm?: boolean;
  what_to_extract?: string;
}

// Extraction suffix is kept in runtime config.
function getExtractionSuffix(): string {
  return REDDIT.EXTRACTION_SUFFIX;
}

function enhanceExtractionInstruction(instruction: string | undefined): string {
  const base = instruction || 'Extract key insights, recommendations, and community consensus from these Reddit discussions.';
  return `${base}\n\n${getExtractionSuffix()}`;
}

// --- Internal types ---

interface PostProcessResult {
  successful: number;
  failed: number;
  llmErrors: number;
  llmAvailable: boolean;
  contents: string[];
}

// --- Helpers ---

function validatePostCount(urlCount: number): string | null {
  if (urlCount < REDDIT.MIN_POSTS) {
    return formatError({
      code: 'MIN_POSTS',
      message: `Minimum ${REDDIT.MIN_POSTS} Reddit posts required. Received: ${urlCount}`,
      toolName: 'get-reddit-post',
      howToFix: [`Add at least ${REDDIT.MIN_POSTS - urlCount} more Reddit URL(s)`],
      alternatives: [
        `search-reddit(queries=["topic discussion", "topic recommendations", "topic experiences"]) — find more Reddit posts first, then call get-reddit-post with ${REDDIT.MIN_POSTS}+ URLs`,
      ],
    });
  }
  if (urlCount > REDDIT.MAX_POSTS) {
    return formatError({
      code: 'MAX_POSTS',
      message: `Maximum ${REDDIT.MAX_POSTS} Reddit posts allowed. Received: ${urlCount}`,
      toolName: 'get-reddit-post',
      howToFix: [`Remove ${urlCount - REDDIT.MAX_POSTS} URL(s) and retry`],
    });
  }
  return null;
}

async function applyLlmToPost(
  postContent: string,
  result: PostResult,
  url: string,
  llmProcessor: NonNullable<ReturnType<typeof createLLMProcessor>>,
  enhancedInstruction: string | undefined,
  tokensPerUrl: number,
  index: number,
  total: number,
): Promise<{ content: string; llmFailed: boolean }> {
  mcpLog('info', `[${index}/${total}] Applying LLM extraction to ${url}`, 'reddit');

  const llmResult = await processContentWithLLM(
    postContent,
    { use_llm: true, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl },
    llmProcessor,
  );

  if (llmResult.processed) {
    mcpLog('debug', `[${index}/${total}] LLM extraction complete`, 'reddit');
    const header = `## LLM Analysis: ${result.post.title}\n\n**r/${result.post.subreddit}** • u/${result.post.author} • ⬆️ ${result.post.score} • 💬 ${result.post.commentCount} comments\n🔗 ${result.post.url}\n\n`;
    return { content: header + llmResult.content, llmFailed: false };
  }

  mcpLog('warning', `[${index}/${total}] LLM extraction failed: ${llmResult.error || 'unknown'}`, 'reddit');
  return { content: postContent, llmFailed: true };
}

async function fetchAndProcessPosts(
  results: Map<string, PostResult | Error>,
  urls: string[],
  fetchComments: boolean,
  use_llm: boolean,
  what_to_extract: string | undefined,
): Promise<PostProcessResult> {
  const llmProcessor = use_llm ? createLLMProcessor() : null;
  const tokensPerUrl = use_llm ? Math.floor(TOKEN_BUDGETS.RESEARCH / urls.length) : 0;
  const enhancedInstruction = use_llm ? enhanceExtractionInstruction(what_to_extract) : undefined;

  let failed = 0;
  const failedContents: string[] = [];
  const successEntries: { url: string; result: PostResult; content: string }[] = [];

  for (const [url, result] of results) {
    if (result instanceof Error) {
      failed++;
      failedContents.push(`## ❌ Failed: ${url}\n\n_${result.message}_`);
      continue;
    }
    successEntries.push({ url, result, content: formatPost(result, fetchComments) });
  }

  let llmErrors = 0;
  let processedEntries: typeof successEntries;

  if (use_llm && llmProcessor && successEntries.length > 0) {
    const llmResults = await pMap(successEntries, async (entry, index) => {
      const llmOut = await applyLlmToPost(
        entry.content, entry.result, entry.url, llmProcessor, enhancedInstruction,
        tokensPerUrl, index + 1, successEntries.length,
      );
      if (llmOut.llmFailed) llmErrors++;
      return { ...entry, content: llmOut.content };
    }, 3);
    processedEntries = llmResults;
  } else {
    processedEntries = successEntries;
  }

  const contents = [...failedContents, ...processedEntries.map(e => e.content)];

  return { successful: successEntries.length, failed, llmErrors, llmAvailable: llmProcessor !== null, contents };
}

function buildRedditStatusExtras(
  rateLimitHits: number,
  use_llm: boolean,
  llmAvailable: boolean,
  llmErrors: number,
): string {
  const extras: string[] = [];
  if (rateLimitHits > 0) extras.push(`⚠️ ${rateLimitHits} rate limit retries`);
  if (use_llm && !llmAvailable) {
    extras.push('⚠️ LLM unavailable (OPENROUTER_API_KEY not set)');
  } else if (llmErrors > 0) {
    extras.push(`⚠️ ${llmErrors} LLM extraction failures`);
  }
  return extras.length > 0 ? `\n${extras.join(' | ')}` : '';
}

function formatRedditOutput(
  urls: string[],
  processResult: PostProcessResult,
  fetchComments: boolean,
  commentsPerPost: number,
  totalBatches: number,
  use_llm: boolean,
  tokensPerUrl: number,
  extraStatus: string,
): string {
  const batchHeader = formatBatchHeader({
    title: `Reddit Posts`,
    totalItems: urls.length,
    successful: processResult.successful,
    failed: processResult.failed,
    ...(fetchComments ? { extras: { 'Comments/post': commentsPerPost } } : {}),
    ...(use_llm ? { tokensPerItem: tokensPerUrl } : {}),
    batches: totalBatches,
  });

  const nextSteps = [
    processResult.successful > 0 ? 'VERIFY CLAIMS: web-search(keywords=["topic claim1 verify", "topic claim2 official docs", "topic best practices"]) — community says X, verify with web' : null,
    processResult.successful > 0 ? 'SCRAPE REFERENCED LINKS: scrape-links(urls=[...URLs found in comments...], use_llm=true, what_to_extract="Extract evidence | data | recommendations") — follow external links from discussions' : null,
    'BROADEN: search-reddit(queries=[...related angles...]) — if more perspectives needed',
    processResult.successful > 0 ? 'SYNTHESIZE (only after verifying + scraping): deep-research(questions=[{question: "Based on verified Reddit findings about [topic]..."}])' : null,
    processResult.failed > 0 ? 'Retry failed URLs individually' : null,
  ].filter(Boolean) as string[];

  return formatSuccess({
    title: `Reddit Posts Fetched (${processResult.successful}/${urls.length})`,
    summary: batchHeader + extraStatus,
    data: processResult.contents.join('\n\n---\n\n'),
    nextSteps,
  });
}

function formatGetRedditPostsError(error: unknown): string {
  const structuredError = classifyError(error);
  return formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'get-reddit-post',
    howToFix: ['Verify REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set'],
    alternatives: [
      'web-search(keywords=["topic reddit discussion", "topic reddit recommendations"]) — search for Reddit content via web search instead',
      'scrape-links(urls=[...the Reddit URLs...], use_llm=true, what_to_extract="Extract post content | top comments | recommendations") — scrape Reddit pages directly as a fallback',
      'deep-research(questions=[{question: "What are community opinions on [topic]?"}]) — get AI-synthesized community perspective',
    ],
  });
}

export async function handleGetRedditPosts(
  urls: string[],
  clientId: string,
  clientSecret: string,
  maxComments = 100,
  options: GetRedditPostsOptions = {},
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<GetRedditPostOutput>> {
  try {
    const { fetchComments = true, maxCommentsOverride, use_llm = false, what_to_extract } = options;

    const validationError = validatePostCount(urls.length);
    if (validationError) return toolFailure(validationError);

    const allocation = calculateCommentAllocation(urls.length);
    const commentsPerPost = fetchComments ? (maxCommentsOverride || allocation.perPostCapped) : 0;
    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);

    await reporter.log('info', `Fetching ${urls.length} Reddit post(s) across ${totalBatches} batch(es)`);
    await reporter.progress(20, 100, 'Fetching Reddit post content');
    const client = new RedditClient(clientId, clientSecret);
    const batchResult = await client.batchGetPosts(urls, commentsPerPost, fetchComments);
    await reporter.log(
      'info',
      `Fetched Reddit batch results with ${batchResult.rateLimitHits} rate-limit retry/retries`,
    );
    await reporter.progress(55, 100, 'Processing Reddit posts and comments');

    const processResult = await fetchAndProcessPosts(
      batchResult.results, urls, fetchComments, use_llm, what_to_extract,
    );
    await reporter.log(
      'info',
      `Processed ${processResult.successful} successful post(s) with ${processResult.failed} failure(s)`,
    );
    await reporter.progress(85, 100, 'Formatting Reddit output');

    const tokensPerUrl = use_llm ? Math.floor(TOKEN_BUDGETS.RESEARCH / urls.length) : 0;
    const extraStatus = buildRedditStatusExtras(
      batchResult.rateLimitHits, use_llm, processResult.llmAvailable, processResult.llmErrors,
    );
    const content = formatRedditOutput(
      urls,
      processResult,
      fetchComments,
      commentsPerPost,
      totalBatches,
      use_llm,
      tokensPerUrl,
      extraStatus,
    );

    return toolSuccess(content, {
      content,
      metadata: {
        total_urls: urls.length,
        successful: processResult.successful,
        failed: processResult.failed,
        fetch_comments: fetchComments,
        comments_per_post: commentsPerPost,
        llm_requested: use_llm,
        llm_available: processResult.llmAvailable,
        llm_failures: processResult.llmErrors,
        total_batches: totalBatches,
        rate_limit_hits: batchResult.rateLimitHits,
      },
    });
  } catch (error) {
    return toolFailure(formatGetRedditPostsError(error));
  }
}

export function registerSearchRedditTool(server: MCPServer): void {
  server.tool(
    {
      name: 'search-reddit',
      title: 'Search Reddit',
      description:
        'Search Reddit discussions with 3-50 diverse queries and return ranked Reddit URLs for follow-up analysis.',
      schema: searchRedditParamsSchema,
      outputSchema: searchRedditOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ queries, date_after }, ctx) => {
      if (!getCapabilities().search) {
        return toToolResponse(toolFailure(getMissingEnvMessage('search')));
      }

      const env = parseEnv();
      const reporter = createToolReporter(ctx, 'search-reddit');
      const result = await handleSearchReddit(queries, env.SEARCH_API_KEY!, date_after, reporter);

      await reporter.progress(100, 100, result.isError ? 'Reddit search failed' : 'Reddit search complete');
      return toToolResponse(result);
    },
  );
}

export function registerGetRedditPostTool(server: MCPServer): void {
  server.tool(
    {
      name: 'get-reddit-post',
      title: 'Get Reddit Post',
      description:
        'Fetch Reddit posts and comment trees from 2-50 Reddit URLs, optionally with AI extraction.',
      schema: getRedditPostParamsSchema,
      outputSchema: getRedditPostOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ urls, fetch_comments, max_comments, use_llm, what_to_extract }, ctx) => {
      if (!getCapabilities().reddit) {
        return toToolResponse(toolFailure(getMissingEnvMessage('reddit')));
      }

      const env = parseEnv();
      const reporter = createToolReporter(ctx, 'get-reddit-post');
      const result = await handleGetRedditPosts(
        urls,
        env.REDDIT_CLIENT_ID!,
        env.REDDIT_CLIENT_SECRET!,
        max_comments,
        {
          fetchComments: fetch_comments,
          maxCommentsOverride: max_comments !== 100 ? max_comments : undefined,
          use_llm,
          what_to_extract,
        },
        reporter,
      );

      await reporter.progress(100, 100, result.isError ? 'Reddit fetch failed' : 'Reddit fetch complete');
      return toToolResponse(result);
    },
  );
}
