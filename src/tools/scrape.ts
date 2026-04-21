/**
 * Scrape Links Tool Handler
 *
 * Scrapes many URLs in parallel. Reddit permalinks (reddit.com/r/.../comments/...)
 * are auto-detected and routed through the Reddit API; all other URLs go through
 * the scraper. Both branches feed the same per-URL LLM extraction pipeline.
 *
 * NEVER throws — every error is returned as a tool-level failure response.
 */

import type { MCPServer } from 'mcp-use/server';

import {
  SCRAPER,
  CONCURRENCY,
  getCapabilities,
  getMissingEnvMessage,
  parseEnv,
} from '../config/index.js';
import {
  scrapeLinksOutputSchema,
  scrapeLinksParamsSchema,
  type ScrapeLinksParams,
  type ScrapeLinksOutput,
} from '../schemas/scrape-links.js';
import { ScraperClient } from '../clients/scraper.js';
import { RedditClient, type PostResult } from '../clients/reddit.js';
import { MarkdownCleaner } from '../services/markdown-cleaner.js';
import { createLLMProcessor, processContentWithLLM } from '../services/llm-processor.js';
import { removeMetaTags } from '../utils/markdown-formatter.js';
import { extractReadableContent } from '../utils/content-extractor.js';
import { classifyError } from '../utils/errors.js';
import { pMap } from '../utils/concurrency.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  formatDuration,
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

const markdownCleaner = new MarkdownCleaner();

function enhanceExtractionInstruction(instruction: string | undefined): string {
  const base = instruction || 'Extract the main content and key information from this page.';
  return `${SCRAPER.EXTRACTION_PREFIX}\n\n${base}\n\n${SCRAPER.EXTRACTION_SUFFIX}`;
}

// --- Types ---

interface ProcessedResult {
  url: string;
  content: string;
  index: number; // original position in params.urls[]
}

interface ScrapeMetrics {
  successful: number;
  failed: number;
  totalCredits: number;
}

interface ScrapePhaseResult {
  successItems: ProcessedResult[];
  failedContents: string[];
  metrics: ScrapeMetrics;
}

interface BranchInput {
  url: string;
  origIndex: number;
}

interface ScrapeClients {
  client: ScraperClient;
  llmProcessor: ReturnType<typeof createLLMProcessor>;
}

// --- Reddit URL detection ---

const REDDIT_HOST = /(?:^|\.)reddit\.com$/i;
const REDDIT_POST_PERMALINK = /\/r\/[^/]+\/comments\/[a-z0-9]+/i;

function isRedditUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return REDDIT_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

function isRedditPostPermalink(url: string): boolean {
  try {
    const u = new URL(url);
    return REDDIT_HOST.test(u.hostname) && REDDIT_POST_PERMALINK.test(u.pathname);
  } catch {
    return false;
  }
}

// --- Error helper ---

function createScrapeErrorResponse(
  code: string,
  message: string,
  startTime: number,
  retryable = false,
  alternatives?: string[],
): ToolExecutionResult<ScrapeLinksOutput> {
  return toolFailure(
    `${formatError({
      code,
      message,
      retryable,
      toolName: 'scrape-links',
      howToFix: code === 'NO_URLS' ? ['Provide at least one valid URL'] : undefined,
      alternatives,
    })}\n\nExecution time: ${formatDuration(Date.now() - startTime)}`,
  );
}

// --- URL partitioning ---

interface PartitionedUrls {
  webInputs: BranchInput[];
  redditInputs: BranchInput[];
  invalidEntries: { url: string; origIndex: number }[];
}

function partitionUrls(urls: string[]): PartitionedUrls {
  const webInputs: BranchInput[] = [];
  const redditInputs: BranchInput[] = [];
  const invalidEntries: { url: string; origIndex: number }[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    try {
      new URL(url);
    } catch {
      invalidEntries.push({ url, origIndex: i });
      continue;
    }
    if (isRedditUrl(url)) {
      redditInputs.push({ url, origIndex: i });
    } else {
      webInputs.push({ url, origIndex: i });
    }
  }

  return { webInputs, redditInputs, invalidEntries };
}

// --- Web branch ---

async function fetchWebBranch(
  inputs: BranchInput[],
  client: ScraperClient,
): Promise<ScrapePhaseResult> {
  if (inputs.length === 0) {
    return { successItems: [], failedContents: [], metrics: { successful: 0, failed: 0, totalCredits: 0 } };
  }

  mcpLog('info', `[concurrency] web branch: fanning out ${inputs.length} URL(s) with limit=${CONCURRENCY.SCRAPER}`, 'scrape');
  const urls = inputs.map((i) => i.url);
  const results = await client.scrapeMultiple(urls, { timeout: 60 });

  const successItems: ProcessedResult[] = [];
  const failedContents: string[] = [];
  let successful = 0;
  let failed = 0;
  let totalCredits = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const origIndex = inputs[i]!.origIndex;
    if (!result) {
      failed++;
      failedContents.push(`## ${inputs[i]!.url}\n\n❌ No result returned`);
      continue;
    }

    if (result.error || result.statusCode < 200 || result.statusCode >= 300) {
      failed++;
      const errorMsg = result.error?.message || result.content || `HTTP ${result.statusCode}`;
      failedContents.push(`## ${result.url}\n\n❌ Failed to scrape: ${errorMsg}`);
      continue;
    }

    successful++;
    totalCredits += result.credits;

    let content: string;
    try {
      const readable = extractReadableContent(result.content, result.url);
      const sourceForCleaner = readable.extracted ? readable.content : result.content;
      content = markdownCleaner.processContent(sourceForCleaner);
    } catch {
      content = result.content;
    }

    successItems.push({ url: result.url, content, index: origIndex });
  }

  return { successItems, failedContents, metrics: { successful, failed, totalCredits } };
}

// --- Reddit branch ---

function formatRedditPostAsMarkdown(result: PostResult): string {
  const { post, comments } = result;
  const lines: string[] = [];
  lines.push(`# ${post.title}`);
  lines.push('');
  lines.push(`**r/${post.subreddit}** • u/${post.author} • ⬆️ ${post.score} • 💬 ${post.commentCount} comments`);
  lines.push(`🔗 ${post.url}`);
  lines.push('');
  if (post.body) {
    lines.push('## Post content');
    lines.push('');
    lines.push(post.body);
    lines.push('');
  }
  if (comments.length > 0) {
    lines.push(`## Top comments (${comments.length} total)`);
    lines.push('');
    for (const c of comments) {
      const indent = '  '.repeat(c.depth);
      const op = c.isOP ? ' **[OP]**' : '';
      const score = c.score >= 0 ? `+${c.score}` : `${c.score}`;
      lines.push(`${indent}- **u/${c.author}**${op} _(${score})_`);
      for (const line of c.body.split('\n')) {
        lines.push(`${indent}  ${line}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function fetchRedditBranch(inputs: BranchInput[]): Promise<ScrapePhaseResult> {
  if (inputs.length === 0) {
    return { successItems: [], failedContents: [], metrics: { successful: 0, failed: 0, totalCredits: 0 } };
  }

  const env = parseEnv();
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    const failedContents = inputs.map(
      (i) => `## ${i.url}\n\n❌ Reddit URL detected, but Reddit API is not configured. Set \`REDDIT_CLIENT_ID\` and \`REDDIT_CLIENT_SECRET\` in the server env to enable threaded Reddit scraping.`,
    );
    return {
      successItems: [],
      failedContents,
      metrics: { successful: 0, failed: inputs.length, totalCredits: 0 },
    };
  }

  // Warn for non-permalink Reddit URLs (subreddit homepages, /new, /top, /hot,
  // user profiles). The Reddit API path we call requires /r/.../comments/... —
  // reject upfront so the caller sees a helpful message instead of a 404.
  const [postInputs, nonPermalinks] = inputs.reduce<[BranchInput[], BranchInput[]]>(
    ([posts, rest], input) => {
      if (isRedditPostPermalink(input.url)) posts.push(input);
      else rest.push(input);
      return [posts, rest];
    },
    [[], []],
  );

  const nonPermalinkFailed = nonPermalinks.map(
    (i) => `## ${i.url}\n\n❌ Only Reddit post permalinks (/r/<sub>/comments/<id>/...) are supported. Use web-search with scope:"reddit" to discover post permalinks first.`,
  );

  if (postInputs.length === 0) {
    return {
      successItems: [],
      failedContents: nonPermalinkFailed,
      metrics: { successful: 0, failed: nonPermalinks.length, totalCredits: 0 },
    };
  }

  mcpLog('info', `[concurrency] reddit branch: fetching ${postInputs.length} post(s) with limit=${CONCURRENCY.REDDIT}`, 'scrape');
  const client = new RedditClient(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET);
  const urls = postInputs.map((i) => i.url);
  const batchResult = await client.batchGetPosts(urls, true);
  const urlToIndex = new Map(postInputs.map((i) => [i.url, i.origIndex]));

  const successItems: ProcessedResult[] = [];
  const failedContents: string[] = [...nonPermalinkFailed];
  let successful = 0;
  let failed = nonPermalinks.length;

  for (const [url, result] of batchResult.results) {
    const origIndex = urlToIndex.get(url) ?? -1;
    if (result instanceof Error) {
      failed++;
      failedContents.push(`## ${url}\n\n❌ Reddit fetch failed: ${result.message}`);
      continue;
    }
    successful++;
    successItems.push({ url, content: formatRedditPostAsMarkdown(result), index: origIndex });
  }

  return { successItems, failedContents, metrics: { successful, failed, totalCredits: 0 } };
}

// --- LLM extraction (shared by both branches) ---

async function processItemsWithLlm(
  successItems: ProcessedResult[],
  enhancedInstruction: string,
  llmProcessor: ReturnType<typeof createLLMProcessor>,
  reporter: ToolReporter,
): Promise<{ items: ProcessedResult[]; llmErrors: number; llmAttempted: number }> {
  let llmErrors = 0;

  if (!llmProcessor || successItems.length === 0) {
    if (!llmProcessor && successItems.length > 0) {
      mcpLog('warning', 'LLM unavailable (LLM_API_KEY not set). Returning raw scraped content.', 'scrape');
      void reporter.log('warning', 'llm_extractor_unreachable: planner not configured; raw scraped content returned');
    }
    return { items: successItems, llmErrors, llmAttempted: 0 };
  }

  mcpLog('info', `[concurrency] llm extraction: fanning out ${successItems.length} item(s) with limit=${CONCURRENCY.LLM_EXTRACTION}`, 'scrape');

  const llmResults = await pMap(
    successItems,
    async (item) => {
      mcpLog('debug', `LLM extracting ${item.url}...`, 'scrape');

      const llmResult = await processContentWithLLM(
        item.content,
        { enabled: true, extract: enhancedInstruction, url: item.url },
        llmProcessor,
      );

      if (llmResult.processed) {
        return { ...item, content: llmResult.content };
      }

      llmErrors++;
      mcpLog('warning', `LLM extraction failed for ${item.url}: ${llmResult.error || 'unknown reason'}`, 'scrape');
      void reporter.log('warning', `llm_extractor_unreachable: ${item.url} — ${llmResult.error || 'unknown reason'}`);
      return item;
    },
    CONCURRENCY.LLM_EXTRACTION,
  );

  return { items: llmResults, llmErrors, llmAttempted: successItems.length };
}

// --- Output assembly ---

function assembleContentEntries(successItems: ProcessedResult[], failedContents: string[]): string[] {
  const sorted = [...successItems].sort((a, b) => a.index - b.index);
  const contents = [...failedContents];
  for (const item of sorted) {
    let content = item.content;
    try {
      content = removeMetaTags(content);
    } catch {
      // Use content as-is
    }
    contents.push(`## ${item.url}\n\n${content}`);
  }
  return contents;
}

function buildScrapeResponse(
  params: ScrapeLinksParams,
  contents: string[],
  metrics: ScrapeMetrics,
  llmErrors: number,
  executionTime: number,
  llmAccounting: { llmAttempted: number; llmSucceeded: boolean },
): { content: string; structuredContent: ScrapeLinksOutput } {
  const llmExtras: Record<string, string | number> = {};
  if (llmAccounting.llmAttempted > 0) {
    const ok = llmAccounting.llmAttempted - llmErrors;
    llmExtras['LLM extraction'] = `${ok}/${llmAccounting.llmAttempted} succeeded`;
    if (!llmAccounting.llmSucceeded) {
      llmExtras['LLM credit'] = '0 charged (no extraction produced)';
    }
  } else if (llmErrors > 0) {
    llmExtras['LLM extraction failures'] = llmErrors;
  }

  const batchHeader = formatBatchHeader({
    title: `Scraped Content (${params.urls.length} URLs)`,
    totalItems: params.urls.length,
    successful: metrics.successful,
    failed: metrics.failed,
    extras: {
      'Credits used': metrics.totalCredits,
      ...llmExtras,
    },
  });

  const formattedContent = formatSuccess({
    title: 'Scraping Complete',
    summary: batchHeader,
    data: contents.join('\n\n---\n\n'),
    metadata: {
      'Execution time': formatDuration(executionTime),
    },
  });

  const metadata: ScrapeLinksOutput['metadata'] = {
    total_items: params.urls.length,
    successful: metrics.successful,
    failed: metrics.failed,
    execution_time_ms: executionTime,
    total_credits: metrics.totalCredits,
  };
  return { content: formattedContent, structuredContent: { metadata } };
}

// --- Handler ---

export async function handleScrapeLinks(
  params: ScrapeLinksParams,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<ScrapeLinksOutput>> {
  const startTime = Date.now();

  if (!params.urls || params.urls.length === 0) {
    return createScrapeErrorResponse('NO_URLS', 'No URLs provided', startTime);
  }

  const { webInputs, redditInputs, invalidEntries } = partitionUrls(params.urls);
  const validCount = webInputs.length + redditInputs.length;

  await reporter.log(
    'info',
    `Partitioned ${params.urls.length} URL(s): ${webInputs.length} web, ${redditInputs.length} reddit, ${invalidEntries.length} invalid`,
  );

  if (validCount === 0) {
    return createScrapeErrorResponse(
      'INVALID_URLS',
      `All ${params.urls.length} URLs are invalid`,
      startTime,
      false,
      [
        'web-search(queries=[...], extract="...") — search for valid URLs first, then scrape the results',
      ],
    );
  }

  mcpLog(
    'info',
    `Starting scrape: ${webInputs.length} web + ${redditInputs.length} reddit URL(s)`,
    'scrape',
  );
  await reporter.progress(15, 100, 'Preparing scraper clients');

  // Only initialize web clients if we actually have web URLs. Reddit-only
  // batches run without touching the scraper.
  let clients: ScrapeClients | null = null;
  try {
    if (webInputs.length > 0) {
      clients = { client: new ScraperClient(), llmProcessor: createLLMProcessor() };
    } else {
      // Reddit-only: no scraper needed, but still create the LLM processor
      // so the extraction pass runs.
      clients = {
        client: null as unknown as ScraperClient,
        llmProcessor: createLLMProcessor(),
      };
    }
  } catch (error) {
    const err = classifyError(error);
    return createScrapeErrorResponse(
      'CLIENT_INIT_FAILED',
      `Failed to initialize scraper: ${err.message}`,
      startTime,
      false,
      [
        'web-search(queries=["topic key findings", "topic summary"], extract="key findings and summary") — search instead of scraping',
      ],
    );
  }

  const enhancedInstruction = enhanceExtractionInstruction(params.extract);

  await reporter.progress(35, 100, 'Fetching page content');

  // Run both branches in parallel. Failures in one branch do not block the other.
  const [webPhase, redditPhase] = await Promise.all([
    webInputs.length > 0
      ? fetchWebBranch(webInputs, clients.client)
      : Promise.resolve<ScrapePhaseResult>({ successItems: [], failedContents: [], metrics: { successful: 0, failed: 0, totalCredits: 0 } }),
    fetchRedditBranch(redditInputs),
  ]);

  const successItems = [...webPhase.successItems, ...redditPhase.successItems];
  const invalidFailed = invalidEntries.map(
    ({ url }) => `## ${url}\n\n❌ Invalid URL format`,
  );
  const failedContents = [...invalidFailed, ...webPhase.failedContents, ...redditPhase.failedContents];
  const metrics: ScrapeMetrics = {
    successful: webPhase.metrics.successful + redditPhase.metrics.successful,
    failed: invalidEntries.length + webPhase.metrics.failed + redditPhase.metrics.failed,
    totalCredits: webPhase.metrics.totalCredits,
  };

  await reporter.log('info', `Fetched ${metrics.successful} page(s), ${metrics.failed} failed`);

  if (successItems.length > 0) {
    await reporter.progress(80, 100, 'Running LLM extraction over fetched pages');
  }

  const { items: processedItems, llmErrors, llmAttempted } = await processItemsWithLlm(
    successItems,
    enhancedInstruction,
    clients.llmProcessor,
    reporter,
  );

  const contents = assembleContentEntries(processedItems, failedContents);
  const executionTime = Date.now() - startTime;

  mcpLog(
    'info',
    `Completed: ${metrics.successful} successful, ${metrics.failed} failed, ${metrics.totalCredits} credits used`,
    'scrape',
  );

  const llmSucceeded = llmAttempted > 0 && llmErrors < llmAttempted;
  const result = buildScrapeResponse(
    params,
    contents,
    metrics,
    llmErrors,
    executionTime,
    { llmAttempted, llmSucceeded },
  );

  if (metrics.successful === 0 && metrics.failed > 0) {
    return toolFailure(result.content);
  }

  return toolSuccess(result.content, result.structuredContent);
}

export function registerScrapeLinksTool(server: MCPServer): void {
  server.tool(
    {
      name: 'scrape-links',
      title: 'Scrape Links',
      description:
        'Fetch many URLs in parallel and run per-URL structured LLM extraction. Auto-detects reddit.com post permalinks and routes them through the Reddit API (threaded post + comments); everything else flows through the HTTP scraper. Safe to call in parallel — group URLs by context rather than jamming unrelated batches together. Each page returns `## Source`, `## Matches` (verbatim-preserved facts), `## Not found` (explicit gaps), and `## Follow-up signals` (new terms + referenced URLs) that feed the next research loop. Describe the SHAPE of what you want in `extract`, facets separated by `|` (e.g. `root cause | affected versions | fix | workarounds | timeline`).',
      schema: scrapeLinksParamsSchema,
      outputSchema: scrapeLinksOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      if (!getCapabilities().scraping) {
        return toToolResponse(toolFailure(getMissingEnvMessage('scraping')));
      }

      const reporter = createToolReporter(ctx, 'scrape-links');
      const result = await handleScrapeLinks(args, reporter);

      await reporter.progress(100, 100, result.isError ? 'Scrape failed' : 'Scrape complete');
      return toToolResponse(result);
    },
  );
}
