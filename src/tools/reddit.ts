/**
 * Reddit Tools - Search and Fetch
 * NEVER throws - always returns structured response for graceful degradation
 */

import { SearchClient } from '../clients/search.js';
import { RedditClient, calculateCommentAllocation, type PostResult, type Comment } from '../clients/reddit.js';
import { aggregateAndRankReddit, generateRedditEnhancedOutput } from '../utils/url-aggregator.js';
import { REDDIT } from '../config/index.js';
import { classifyError } from '../utils/errors.js';
import { createLLMProcessor, processContentWithLLM } from '../services/llm-processor.js';
import { pMap } from '../utils/concurrency.js';
import { getToolConfig } from '../config/loader.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  TOKEN_BUDGETS,
} from './utils.js';

// ============================================================================
// Formatters
// ============================================================================

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
    toolName: 'search_reddit',
    howToFix: [
      'Try broader or simpler search terms',
      'Check spelling of technical terms',
      'Remove date filters if using them',
    ],
    alternatives: [
      'web_search(keywords=["topic best practices", "topic guide", "topic recommendations 2025"]) — get results from the broader web instead',
      'scrape_links(urls=[...any URLs you already have...], use_llm=true) — if you have URLs from earlier searches, scrape them now',
      'deep_research(questions=[{question: "What are the key findings about [topic]?"}]) — synthesize from AI research',
    ],
  });
}

function formatSearchRedditError(error: unknown): string {
  const structuredError = classifyError(error);
  return formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'search_reddit',
    howToFix: ['Verify SERPER_API_KEY is set correctly'],
    alternatives: [
      'web_search(keywords=["topic recommendations", "topic best practices", "topic vs alternatives"]) — uses the same API key, but try anyway as it may work for general search',
      'deep_research(questions=[{question: "What does the community recommend for [topic]?"}]) — uses a different API (OpenRouter), not affected by this error',
      'scrape_links(urls=[...any URLs you already have...], use_llm=true) — if you have URLs from prior steps, scrape them now',
    ],
  });
}

export async function handleSearchReddit(
  queries: string[],
  apiKey: string,
  dateAfter?: string
): Promise<string> {
  try {
    const limited = queries.slice(0, 50);
    const client = new SearchClient(apiKey);
    const results = await client.searchRedditMultiple(limited, dateAfter);

    const totalResults = countTotalResults(results);
    if (totalResults === 0) {
      return formatNoSearchResults(limited.length);
    }

    const aggregation = aggregateAndRankReddit(results, 3);
    return generateRedditEnhancedOutput(aggregation, limited, results);
  } catch (error) {
    return formatSearchRedditError(error);
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

// Get extraction suffix from YAML config (fallback to hardcoded if not found)
function getExtractionSuffix(): string {
  const config = getToolConfig('get_reddit_post');
  const suffix = config?.limits?.extraction_suffix;
  if (typeof suffix === 'string') return suffix;
  return `
---

⚠️ IMPORTANT: Extract and synthesize the key insights, opinions, and recommendations from these Reddit discussions. Focus on:
- Common themes and consensus across posts
- Specific recommendations with context
- Contrasting viewpoints and debates
- Real-world experiences and lessons learned
- Technical details and implementation tips

Be comprehensive but concise. Prioritize actionable insights.

---`;
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
      toolName: 'get_reddit_post',
      howToFix: [`Add at least ${REDDIT.MIN_POSTS - urlCount} more Reddit URL(s)`],
      alternatives: [
        `search_reddit(queries=["topic discussion", "topic recommendations", "topic experiences"]) — find more Reddit posts first, then call get_reddit_post with ${REDDIT.MIN_POSTS}+ URLs`,
      ],
    });
  }
  if (urlCount > REDDIT.MAX_POSTS) {
    return formatError({
      code: 'MAX_POSTS',
      message: `Maximum ${REDDIT.MAX_POSTS} Reddit posts allowed. Received: ${urlCount}`,
      toolName: 'get_reddit_post',
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
    processResult.successful > 0 ? 'VERIFY CLAIMS: web_search(keywords=["topic claim1 verify", "topic claim2 official docs", "topic best practices"]) — community says X, verify with web' : null,
    processResult.successful > 0 ? 'SCRAPE REFERENCED LINKS: scrape_links(urls=[...URLs found in comments...], use_llm=true, what_to_extract="Extract evidence | data | recommendations") — follow external links from discussions' : null,
    'BROADEN: search_reddit(queries=[...related angles...]) — if more perspectives needed',
    processResult.successful > 0 ? 'SYNTHESIZE (only after verifying + scraping): deep_research(questions=[{question: "Based on verified Reddit findings about [topic]..."}])' : null,
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
    toolName: 'get_reddit_post',
    howToFix: ['Verify REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set'],
    alternatives: [
      'web_search(keywords=["topic reddit discussion", "topic reddit recommendations"]) — search for Reddit content via web search instead',
      'scrape_links(urls=[...the Reddit URLs...], use_llm=true, what_to_extract="Extract post content | top comments | recommendations") — scrape Reddit pages directly as a fallback',
      'deep_research(questions=[{question: "What are community opinions on [topic]?"}]) — get AI-synthesized community perspective',
    ],
  });
}

export async function handleGetRedditPosts(
  urls: string[],
  clientId: string,
  clientSecret: string,
  maxComments = 100,
  options: GetRedditPostsOptions = {}
): Promise<string> {
  try {
    const { fetchComments = true, maxCommentsOverride, use_llm = false, what_to_extract } = options;

    const validationError = validatePostCount(urls.length);
    if (validationError) return validationError;

    const allocation = calculateCommentAllocation(urls.length);
    const commentsPerPost = fetchComments ? (maxCommentsOverride || allocation.perPostCapped) : 0;
    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);

    const client = new RedditClient(clientId, clientSecret);
    const batchResult = await client.batchGetPosts(urls, commentsPerPost, fetchComments);

    const processResult = await fetchAndProcessPosts(
      batchResult.results, urls, fetchComments, use_llm, what_to_extract,
    );

    const tokensPerUrl = use_llm ? Math.floor(TOKEN_BUDGETS.RESEARCH / urls.length) : 0;
    const extraStatus = buildRedditStatusExtras(
      batchResult.rateLimitHits, use_llm, processResult.llmAvailable, processResult.llmErrors,
    );

    return formatRedditOutput(
      urls, processResult, fetchComments, commentsPerPost,
      totalBatches, use_llm, tokensPerUrl, extraStatus,
    );
  } catch (error) {
    return formatGetRedditPostsError(error);
  }
}
