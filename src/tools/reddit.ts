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
import { aggregateAndRankReddit, generateRedditEnhancedOutput } from '../utils/url-aggregator.js';
import { REDDIT, CONCURRENCY, getCapabilities, getMissingEnvMessage, parseEnv } from '../config/index.js';
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
      md += `\n_${commentsResult.truncated} more comments not shown (word budget reached). Use use_llm=true for AI-synthesized summary._\n\n`;
    }
  } else if (!fetchComments) {
    md += `_Comments not fetched (fetch_comments=false)_\n\n`;
  }

  return { md, wordsUsed, commentsShown, commentsTruncated };
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
    const rawContent = generateRedditEnhancedOutput(aggregation, limited, results);
    const content = rawContent + '\n---\n**Next Steps:**\n→ get-reddit-post with top URLs to read full threads and comments\n→ web-search to cross-reference Reddit findings with official sources\n';
    await reporter.log('info', `Collected ${totalResults} Reddit results across ${limited.length} queries`);
    await reporter.progress(85, 100, 'Ranking Reddit results');
    return toolSuccess(content, {
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
  const successEntries: { url: string; result: PostResult; content: string; wordsUsed: number }[] = [];
  const skippedUrls: string[] = [];
  let totalWordsUsed = 0;

  for (const [url, result] of results) {
    if (result instanceof Error) {
      failed++;
      failedContents.push(`## ❌ Failed: ${url}\n\n_${result.message}_`);
      continue;
    }

    // Check total word budget before formatting this post
    if (totalWordsUsed >= REDDIT.MAX_WORDS_TOTAL) {
      skippedUrls.push(url);
      continue;
    }

    const formatted = formatPost(result, fetchComments, REDDIT.MAX_WORDS_PER_POST);
    totalWordsUsed += formatted.wordsUsed;
    successEntries.push({ url, result, content: formatted.md, wordsUsed: formatted.wordsUsed });
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
    }, CONCURRENCY.LLM_EXTRACTION);
    processedEntries = llmResults;
  } else {
    processedEntries = successEntries;
  }

  const contents = [...failedContents, ...processedEntries.map(e => e.content)];

  return { successful: successEntries.length, failed, llmErrors, llmAvailable: llmProcessor !== null, contents, totalWordsUsed, skippedUrls };
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
    ...(fetchComments ? { extras: { 'Words used': processResult.totalWordsUsed.toLocaleString(), 'Word budget/post': REDDIT.MAX_WORDS_PER_POST.toLocaleString() } } : {}),
    ...(use_llm ? { tokensPerItem: tokensPerUrl } : {}),
    batches: totalBatches,
  });

  let data = processResult.contents.join('\n\n---\n\n');

  // Add truncation notice for skipped posts
  if (processResult.skippedUrls.length > 0) {
    data += '\n\n---\n\n';
    data += `**Word limit reached (${REDDIT.MAX_WORDS_TOTAL.toLocaleString()} words).** The following posts were not included:\n`;
    for (const url of processResult.skippedUrls) {
      data += `- ${url}\n`;
    }
    data += `\nTo get these posts, call get-reddit-post again with just these URLs, or use use_llm=true for AI-synthesized summaries.`;
  }

  return formatSuccess({
    title: `Reddit Posts Fetched (${processResult.successful}/${urls.length})`,
    summary: batchHeader + extraStatus,
    data,
    nextSteps: [
      processResult.successful > 0 ? 'web-search to verify claims from Reddit discussions' : null,
      processResult.successful > 0 ? 'scrape-links on URLs referenced in comments' : null,
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
      'web-search(keywords=["topic reddit discussion", "topic reddit recommendations"]) — search for Reddit content via web search instead',
      'scrape-links(urls=[...the Reddit URLs...], use_llm=true, what_to_extract="Extract post content | top comments | recommendations") — scrape Reddit pages directly as a fallback',
    ],
  });
}

export async function handleGetRedditPosts(
  urls: string[],
  clientId: string,
  clientSecret: string,
  options: GetRedditPostsOptions = {},
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<GetRedditPostOutput>> {
  try {
    const { fetchComments = true, use_llm = false, what_to_extract } = options;

    const validationError = validatePostCount(urls.length);
    if (validationError) return toolFailure(validationError);

    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);

    await reporter.log('info', `Fetching ${urls.length} Reddit post(s) across ${totalBatches} batch(es)`);
    await reporter.progress(20, 100, 'Fetching Reddit post content');
    const client = new RedditClient(clientId, clientSecret);
    const batchResult = await client.batchGetPosts(urls, fetchComments);
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
      `Processed ${processResult.successful} successful post(s) with ${processResult.failed} failure(s), ${processResult.totalWordsUsed.toLocaleString()} words`,
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
      totalBatches,
      use_llm,
      tokensPerUrl,
      extraStatus,
    );

    return toolSuccess(content, {
      metadata: {
        total_urls: urls.length,
        successful: processResult.successful,
        failed: processResult.failed,
        fetch_comments: fetchComments,
        max_words_per_post: REDDIT.MAX_WORDS_PER_POST,
        total_words_used: processResult.totalWordsUsed,
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
        'Search Reddit for community discussions using 1–50 queries and return consensus-ranked Reddit post URLs. Supply 3–7 diverse queries for best consensus detection — each targeting a different angle (direct topic, "best of" lists, comparisons, pain points, subreddit-specific, year-specific). Single queries work but produce no cross-query consensus signal. Output is a ranked URL list ready to pipe into get-reddit-post.',
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
        'Fetch full Reddit posts with complete comment trees from 1–50 Reddit URLs. Recommended: 2–10 URLs for comparative research across discussions. Each post gets up to 20K words of comment depth (100K total budget). Comments are threaded with author, score, and OP markers. Best used after search-reddit to deep-dive into the top-ranked URLs. Keep use_llm=false (default) to get raw threaded comments — only flip to true when you have lots of posts and individual comments don\'t matter.',
      schema: getRedditPostParamsSchema,
      outputSchema: getRedditPostOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ urls, fetch_comments, use_llm, what_to_extract }, ctx) => {
      if (!getCapabilities().reddit) {
        return toToolResponse(toolFailure(getMissingEnvMessage('reddit')));
      }

      const env = parseEnv();
      const reporter = createToolReporter(ctx, 'get-reddit-post');
      const result = await handleGetRedditPosts(
        urls,
        env.REDDIT_CLIENT_ID!,
        env.REDDIT_CLIENT_SECRET!,
        {
          fetchComments: fetch_comments,
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
