/**
 * Reddit Tools — get-reddit-post
 *
 * NEVER throws - always returns structured response for graceful degradation.
 *
 * Note: search-reddit was deleted in mcp-revisions/tool-surface/01. Reddit
 * discovery now flows through `web-search` with `scope: "reddit"`. See
 * mcp-revisions/tool-surface/04 for the rationale on keeping
 * get-reddit-post separate (Reddit threads have a structurally different
 * response shape than HTML pages).
 */

import type { MCPServer } from 'mcp-use/server';

import {
  getRedditPostParamsSchema,
  getRedditPostOutputSchema,
  type GetRedditPostOutput,
} from '../schemas/reddit.js';
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
        `web-search(queries=["topic discussion", "topic recommendations"], extract="...", scope: "reddit") — find more Reddit post permalinks first, then call get-reddit-post with ${REDDIT.MIN_POSTS}+ URLs`,
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

  // No cookie-cutter "Next Steps" with literal `[...]` placeholders here
  // either. See: docs/code-review/context/07-derailment-evidence.md
  // ([FOOTER-BAD]) and mcp-revisions/output-shaping/05.
  return formatSuccess({
    title: `Reddit Posts Fetched (${processResult.successful}/${urls.length})`,
    summary: batchHeader + extraStatus,
    data,
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

    // Contract: zero successful posts in a non-empty batch → isError:true so
    // callers that check response.isError can short-circuit. Partial success
    // still resolves through toolSuccess so the agent sees both rows. See
    // docs/code-review/context/02-current-tool-surface.md (E6).
    if (processResult.successful === 0 && processResult.failed > 0) {
      return toolFailure(content);
    }

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
