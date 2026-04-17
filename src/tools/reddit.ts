/**
 * Reddit Tools - Search and Fetch
 * NEVER throws - always returns structured response for graceful degradation
 */

import type { MCPServer } from 'mcp-use/server';

import {
  searchRedditParamsSchema,
  searchRedditOutputSchema,
  getRedditPostParamsSchema,
  getRedditPostOutputSchema,
  type SearchRedditOutput,
  type GetRedditPostOutput,
} from '../schemas/reddit.js';
import { SearchClient } from '../clients/search.js';
import { RedditClient, type PostResult, type Comment } from '../clients/reddit.js';
import { REDDIT, getCapabilities, getMissingEnvMessage, parseEnv } from '../config/index.js';
import { classifyError } from '../utils/errors.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
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
import { requireBootstrap } from '../utils/bootstrap-guard.js';

// ============================================================================
// Formatters
// ============================================================================

function countWords(text: string): number {
  const plain = text.replace(/[*_~`#>|[\]()!-]/g, '');
  return plain.split(/\s+/).filter(w => w.length > 0).length;
}

interface FormattedCommentsResult {
  md: string;
  wordsUsed: number;
  shown: number;
  truncated: number;
}

function formatComments(comments: Comment[], maxWords: number): FormattedCommentsResult {
  let md = '';
  let wordsUsed = 0;
  let shown = 0;

  for (const c of comments) {
    const indent = '  '.repeat(c.depth);
    const op = c.isOP ? ' **[OP]**' : '';
    const score = c.score >= 0 ? `+${c.score}` : `${c.score}`;
    const authorLine = `${indent}- **u/${c.author}**${op} _(${score})_\n`;
    const bodyLines = c.body.split('\n').map(line => `${indent}  ${line}`).join('\n');
    const commentMd = `${authorLine}${bodyLines}\n\n`;
    const commentWords = countWords(commentMd);

    if (wordsUsed + commentWords > maxWords && shown > 0) break;

    md += commentMd;
    wordsUsed += commentWords;
    shown++;
  }

  return { md, wordsUsed, shown, truncated: comments.length - shown };
}

interface FormattedPostResult {
  md: string;
  wordsUsed: number;
  commentsShown: number;
  commentsTruncated: number;
}

function formatPost(result: PostResult, fetchComments: boolean, maxWords: number): FormattedPostResult {
  const { post, comments } = result;
  let md = `## ${post.title}\n\n`;
  md += `**r/${post.subreddit}** • u/${post.author} • ⬆️ ${post.score} • 💬 ${post.commentCount} comments\n`;
  md += `🔗 ${post.url}\n\n`;

  let wordsUsed = countWords(md);

  if (post.body) {
    const bodySection = `### Post Content\n\n${post.body}\n\n`;
    wordsUsed += countWords(bodySection);
    md += bodySection;
  }

  let commentsShown = 0;
  let commentsTruncated = 0;

  if (fetchComments && comments.length > 0) {
    const remainingWords = Math.max(0, maxWords - wordsUsed);
    const commentsResult = formatComments(comments, remainingWords);
    commentsShown = commentsResult.shown;
    commentsTruncated = commentsResult.truncated;

    md += `### Top Comments (${commentsResult.shown}/${post.commentCount} shown, ${commentsResult.wordsUsed.toLocaleString()} words)\n\n`;
    md += commentsResult.md;
    wordsUsed += commentsResult.wordsUsed;

    if (commentsResult.truncated > 0) {
      md += `\n_${commentsResult.truncated} more comments not shown (word budget reached)._\n\n`;
    }
  }

  return { md, wordsUsed, commentsShown, commentsTruncated };
}

// ============================================================================
// Search Reddit Handler (simplified — returns flat URL list)
// ============================================================================

export async function handleSearchReddit(
  queries: string[],
  apiKey: string,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<SearchRedditOutput>> {
  try {
    const startTime = Date.now();
    const client = new SearchClient(apiKey);
    await reporter.log('info', `Searching Reddit with ${queries.length} queries`);
    await reporter.progress(15, 100, 'Searching Reddit');
    const results = await client.searchRedditMultiple(queries);

    // Collect all unique URLs
    const allUrls = new Set<string>();
    for (const resultSet of results.values()) {
      for (const result of resultSet) {
        if (result.url) allUrls.add(result.url);
      }
    }

    if (allUrls.size === 0) {
      return toolFailure(formatError({
        code: 'NO_RESULTS',
        message: `No Reddit URLs found for any of the ${queries.length} queries`,
        toolName: 'search-reddit',
        howToFix: ['Try broader or simpler search terms', 'Check spelling'],
        alternatives: ['web-search(queries=["topic reddit discussion"], extract="...") — broader Google search'],
      }));
    }

    const urlList = [...allUrls];
    const content = urlList.join('\n');

    await reporter.log('info', `Found ${urlList.length} unique Reddit URLs across ${queries.length} queries`);
    await reporter.progress(100, 100, 'Reddit search complete');

    const executionTime = Date.now() - startTime;
    return toolSuccess(content, {
      content,
      metadata: {
        total_items: queries.length,
        successful: urlList.length,
        failed: 0,
        execution_time_ms: executionTime,
      },
    });
  } catch (error) {
    const structuredError = classifyError(error);
    return toolFailure(formatError({
      code: structuredError.code,
      message: structuredError.message,
      retryable: structuredError.retryable,
      toolName: 'search-reddit',
      howToFix: ['Verify SERPER_API_KEY is set correctly'],
    }));
  }
}

// ============================================================================
// Get Reddit Posts Handler
// ============================================================================

// get-reddit-post no longer uses LLM — returns raw posts + comments

// --- Internal types ---

interface PostProcessResult {
  successful: number;
  failed: number;
  llmErrors: number;
  llmAvailable: boolean;
  contents: string[];
  totalWordsUsed: number;
  skippedUrls: string[];
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

async function fetchAndProcessPosts(
  results: Map<string, PostResult | Error>,
): Promise<PostProcessResult> {
  let failed = 0;
  const failedContents: string[] = [];
  const successContents: string[] = [];
  let successful = 0;
  let totalWordsUsed = 0;
  const skippedUrls: string[] = [];

  for (const [url, result] of results) {
    if (result instanceof Error) {
      failed++;
      failedContents.push(`## ❌ Failed: ${url}\n\n_${result.message}_`);
      continue;
    }

    if (totalWordsUsed >= REDDIT.MAX_WORDS_TOTAL) {
      skippedUrls.push(url);
      continue;
    }

    const formatted = formatPost(result, true, REDDIT.MAX_WORDS_PER_POST);
    totalWordsUsed += formatted.wordsUsed;
    successContents.push(formatted.md);
    successful++;
  }

  const contents = [...failedContents, ...successContents];
  return { successful, failed, llmErrors: 0, llmAvailable: false, contents, totalWordsUsed, skippedUrls };
}

function buildRedditStatusExtras(
  rateLimitHits: number,
  llmAvailable: boolean,
  llmErrors: number,
): string {
  const extras: string[] = [];
  if (rateLimitHits > 0) extras.push(`⚠️ ${rateLimitHits} rate limit retries`);
  if (!llmAvailable) {
    extras.push('⚠️ LLM unavailable (LLM_EXTRACTION_API_KEY not set) — raw content returned');
  } else if (llmErrors > 0) {
    extras.push(`⚠️ ${llmErrors} LLM extraction failures`);
  }
  return extras.length > 0 ? `\n${extras.join(' | ')}` : '';
}

function formatRedditOutput(
  urls: string[],
  processResult: PostProcessResult,
  fetchComments: boolean,
  totalBatches: number,
  tokensPerUrl: number,
  extraStatus: string,
): string {
  const batchHeader = formatBatchHeader({
    title: `Reddit Posts`,
    totalItems: urls.length,
    successful: processResult.successful,
    failed: processResult.failed,
    ...(fetchComments ? { extras: { 'Words used': processResult.totalWordsUsed.toLocaleString() } } : {}),
    tokensPerItem: tokensPerUrl,
    batches: totalBatches,
  });

  let data = processResult.contents.join('\n\n---\n\n');

  if (processResult.skippedUrls.length > 0) {
    data += '\n\n---\n\n';
    data += `**Word limit reached (${REDDIT.MAX_WORDS_TOTAL.toLocaleString()} words).** The following posts were not included:\n`;
    for (const url of processResult.skippedUrls) {
      data += `- ${url}\n`;
    }
    data += `\nCall get-reddit-post(urls=[...skipped URLs above...]) with just the skipped URLs.`;
  }

  return formatSuccess({
    title: `Reddit Posts Fetched (${processResult.successful}/${urls.length})`,
    summary: batchHeader + extraStatus,
    data,
    nextSteps: [
      processResult.successful > 0 ? 'web-search(queries=[...], extract="verify claims from Reddit") — cross-check Reddit findings' : null,
      processResult.successful > 0 ? 'scrape-links(urls=[...URLs from comments...], extract="...") — scrape URLs referenced in comments' : null,
      processResult.failed > 0 ? 'Retry failed URLs individually' : null,
    ].filter(Boolean) as string[],
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
      'web-search(queries=["topic reddit discussion", "topic reddit recommendations"], extract="reddit discussions and recommendations") — search for Reddit content via web search instead',
      'scrape-links(urls=[...the Reddit URLs...], extract="post content | top comments | recommendations") — scrape Reddit pages directly as a fallback',
    ],
  });
}

export async function handleGetRedditPosts(
  urls: string[],
  clientId: string,
  clientSecret: string,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<GetRedditPostOutput>> {
  const startTime = Date.now();
  try {
    const validationError = validatePostCount(urls.length);
    if (validationError) return toolFailure(validationError);

    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);

    await reporter.log('info', `Fetching ${urls.length} Reddit post(s)`);
    await reporter.progress(20, 100, 'Fetching Reddit posts');
    const client = new RedditClient(clientId, clientSecret);
    const batchResult = await client.batchGetPosts(urls, true);
    await reporter.progress(55, 100, 'Formatting posts and comments');

    const processResult = await fetchAndProcessPosts(batchResult.results);
    await reporter.progress(85, 100, 'Building output');

    const extraStatus = buildRedditStatusExtras(
      batchResult.rateLimitHits, false, 0,
    );
    const content = formatRedditOutput(
      urls, processResult, true, totalBatches, 0, extraStatus,
    );

    const executionTime = Date.now() - startTime;
    return toolSuccess(content, {
      content,
      metadata: {
        total_items: urls.length,
        successful: processResult.successful,
        failed: processResult.failed,
        execution_time_ms: executionTime,
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
        'Search Google for Reddit posts matching up to 100 queries. Returns a flat list of unique Reddit URLs ready to pipe into get-reddit-post.',
      schema: searchRedditParamsSchema,
      outputSchema: searchRedditOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ queries }, ctx) => {
      if (!getCapabilities().search) {
        return toToolResponse(toolFailure(getMissingEnvMessage('search')));
      }

      const guard = await requireBootstrap(ctx);
      if (guard) {
        return guard;
      }

      const env = parseEnv();
      const reporter = createToolReporter(ctx, 'search-reddit');
      const result = await handleSearchReddit(queries, env.SEARCH_API_KEY!, reporter);

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
        'Fetch up to 100 Reddit posts with full threaded comment trees. Returns the raw post content and all comments with author, score, and OP markers.',
      schema: getRedditPostParamsSchema,
      outputSchema: getRedditPostOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ urls }, ctx) => {
      if (!getCapabilities().reddit) {
        return toToolResponse(toolFailure(getMissingEnvMessage('reddit')));
      }

      const guard = await requireBootstrap(ctx);
      if (guard) {
        return guard;
      }

      const env = parseEnv();
      const reporter = createToolReporter(ctx, 'get-reddit-post');
      const result = await handleGetRedditPosts(
        urls,
        env.REDDIT_CLIENT_ID!,
        env.REDDIT_CLIENT_SECRET!,
        reporter,
      );

      await reporter.progress(100, 100, result.isError ? 'Reddit fetch failed' : 'Reddit fetch complete');
      return toToolResponse(result);
    },
  );
}
