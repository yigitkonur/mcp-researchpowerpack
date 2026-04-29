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
import { JinaClient } from '../clients/jina.js';
import { MarkdownCleaner } from '../services/markdown-cleaner.js';
import { createLLMProcessor, processContentWithLLM } from '../services/llm-processor.js';
import { removeMetaTags } from '../utils/markdown-formatter.js';
import { extractReadableContent } from '../utils/content-extractor.js';
import { classifyError, ErrorCode } from '../utils/errors.js';
import { isDocumentUrl } from '../utils/source-type.js';
import { pMap, pMapSettled } from '../utils/concurrency.js';
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
  /**
   * Cleaned markdown captured before LLM extraction. Preserved so the handler
   * can fall back to it when the LLM emits the terse "Page did not load: X"
   * escape line and would otherwise nuke the scraped body.
   */
  rawContent?: string;
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
  jinaClient: JinaClient;
  llmProcessor: ReturnType<typeof createLLMProcessor>;
}

/**
 * Any URL the web branch decides to hand off to Jina Reader — either because
 * Scrape.do returned a binary content-type, or because Scrape.do failed
 * outright (non-404 error). `scrapeError` is preserved so that, if Jina also
 * fails, the final error message can surface both layers.
 *
 * Genuine 404s are NOT put here — the URL doesn't exist; Jina won't help.
 */
interface JinaFallback {
  url: string;
  origIndex: number;
  reason: 'binary_content' | 'scrape_failed';
  scrapeError?: string;
}

interface WebPhaseResult extends ScrapePhaseResult {
  jinaFallbacks: JinaFallback[];
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
  documentInputs: BranchInput[];
  invalidEntries: { url: string; origIndex: number }[];
}

function partitionUrls(urls: string[]): PartitionedUrls {
  const webInputs: BranchInput[] = [];
  const redditInputs: BranchInput[] = [];
  const documentInputs: BranchInput[] = [];
  const invalidEntries: { url: string; origIndex: number }[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    try {
      new URL(url);
    } catch {
      invalidEntries.push({ url, origIndex: i });
      continue;
    }
    // Document URLs (.pdf/.docx/.pptx/.xlsx) go straight to Jina Reader —
    // bypassing Scrape.do because it cannot decode binary bodies. Ordered
    // before the Reddit check so a hypothetical PDF on a reddit-adjacent host
    // still takes the document path.
    if (isDocumentUrl(url)) {
      documentInputs.push({ url, origIndex: i });
    } else if (isRedditUrl(url)) {
      redditInputs.push({ url, origIndex: i });
    } else {
      webInputs.push({ url, origIndex: i });
    }
  }

  return { webInputs, redditInputs, documentInputs, invalidEntries };
}

// --- Web branch ---

async function fetchWebBranch(
  inputs: BranchInput[],
  client: ScraperClient,
): Promise<WebPhaseResult> {
  if (inputs.length === 0) {
    return {
      successItems: [],
      failedContents: [],
      metrics: { successful: 0, failed: 0, totalCredits: 0 },
      jinaFallbacks: [],
    };
  }

  mcpLog('info', `[concurrency] web branch: fanning out ${inputs.length} URL(s) with limit=${CONCURRENCY.SCRAPER}`, 'scrape');
  const urls = inputs.map((i) => i.url);
  const results = await client.scrapeMultiple(urls, { timeout: 60 });
  const urlToIndex = new Map(inputs.map((i) => [i.url, i.origIndex]));

  const successItems: ProcessedResult[] = [];
  const failedContents: string[] = [];
  const jinaFallbacks: JinaFallback[] = [];
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

    // Binary document detected by content-type — defer to Jina Reader.
    if (result.error?.code === ErrorCode.UNSUPPORTED_BINARY_CONTENT) {
      jinaFallbacks.push({
        url: result.url,
        origIndex: urlToIndex.get(result.url) ?? origIndex,
        reason: 'binary_content',
      });
      continue;
    }

    // Scrape.do failure — only 404s are treated as hard fails (Jina won't
    // help when the page genuinely doesn't exist). Every other failure mode
    // (302 redirect loops, WAF blocks, timeouts, 5xx, service unavailable)
    // gets a second chance through Jina Reader, which uses different IPs
    // and handles many anti-bot surfaces differently.
    const scrapeFailed = Boolean(result.error) || result.statusCode < 200 || result.statusCode >= 300;
    if (scrapeFailed && result.statusCode !== 404) {
      jinaFallbacks.push({
        url: result.url,
        origIndex: urlToIndex.get(result.url) ?? origIndex,
        reason: 'scrape_failed',
        scrapeError: result.error?.message || result.content || `HTTP ${result.statusCode}`,
      });
      continue;
    }
    if (scrapeFailed) {
      failed++;
      failedContents.push(`## ${result.url}\n\n❌ Failed to scrape: HTTP 404 — Page not found`);
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

    successItems.push({ url: result.url, content, index: origIndex, rawContent: content });
  }

  return {
    successItems,
    failedContents,
    metrics: { successful, failed, totalCredits },
    jinaFallbacks,
  };
}

// --- Document branch (Jina Reader) ---

/**
 * Format a Jina-failure line. If the URL was deferred here *after* Scrape.do
 * already failed, surface both layers' errors so the caller can see that this
 * isn't just a Jina glitch — the primary path failed too.
 *
 * Exported for unit testing.
 */
export function formatJinaFailure(url: string, jinaError: string, scrapeError?: string): string {
  if (scrapeError) {
    return `## ${url}\n\n❌ Both scrapers failed. Scrape.do: ${scrapeError}. Jina Reader: ${jinaError}.`;
  }
  return `## ${url}\n\n❌ Document conversion failed: ${jinaError}`;
}

async function fetchDocumentBranch(
  inputs: BranchInput[],
  jinaClient: JinaClient,
  /** Optional: map url → original Scrape.do error, for fallback messaging. */
  scrapeErrorContext?: Map<string, string>,
): Promise<ScrapePhaseResult> {
  if (inputs.length === 0) {
    return { successItems: [], failedContents: [], metrics: { successful: 0, failed: 0, totalCredits: 0 } };
  }

  mcpLog(
    'info',
    `[concurrency] document branch (jina): converting ${inputs.length} URL(s) with limit=${CONCURRENCY.SCRAPER}`,
    'scrape',
  );

  const results = await pMapSettled(
    inputs,
    (input) => jinaClient.convert({ url: input.url }),
    CONCURRENCY.SCRAPER,
  );

  const successItems: ProcessedResult[] = [];
  const failedContents: string[] = [];
  let successful = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    const input = inputs[i]!;
    const scrapeError = scrapeErrorContext?.get(input.url);
    if (!settled) {
      failed++;
      failedContents.push(formatJinaFailure(input.url, 'No result returned', scrapeError));
      continue;
    }
    if (settled.status === 'rejected') {
      failed++;
      const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      failedContents.push(formatJinaFailure(input.url, reason, scrapeError));
      continue;
    }

    const result = settled.value;
    if (result.error || result.statusCode < 200 || result.statusCode >= 300) {
      failed++;
      const errorMsg = result.error?.message || `HTTP ${result.statusCode}`;
      failedContents.push(formatJinaFailure(input.url, errorMsg, scrapeError));
      continue;
    }

    successful++;
    successItems.push({ url: input.url, content: result.content, index: input.origIndex, rawContent: result.content });
  }

  return { successItems, failedContents, metrics: { successful, failed, totalCredits: 0 } };
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
    const md = formatRedditPostAsMarkdown(result);
    successItems.push({ url, content: md, index: origIndex, rawContent: md });
  }

  return { successItems, failedContents, metrics: { successful, failed, totalCredits: 0 } };
}

// --- Terse-LLM-escape detection + raw fallback merger ---

/**
 * The LLM extraction prompt tells the model to emit a single terse line when
 * a page "clearly failed to load" (login walls, JS-render-empty, paywalls,
 * etc.). In practice the LLM over-triggers this on partially-rendered pages,
 * causing scrape-links to return a one-line verdict and discard the cleaned
 * markdown. This detector + merger keep the verdict but re-attach a capped
 * slice of the raw markdown so the caller always has something to work with.
 */
const TERSE_LLM_FAILURE_RE =
  /^\s*##\s*Matches\s*\n+\s*_Page did not load:\s*([a-z0-9_-]+)_\s*\.?\s*$/i;

/** Cap on the raw-markdown slice appended under "## Raw content ..." */
export const RAW_FALLBACK_CHAR_CAP = 4000;

/**
 * If `llmOutput` is exactly the terse "## Matches\n_Page did not load: X_"
 * line, return the reason token (e.g. "login-wall"). Otherwise null.
 */
export function detectTerseFailure(llmOutput: string): string | null {
  const m = llmOutput.trim().match(TERSE_LLM_FAILURE_RE);
  return m ? m[1]! : null;
}

/**
 * When the LLM emitted the terse escape line, append a capped slice of the
 * raw cleaned markdown under a `## Raw content (...)` section so the caller
 * still has the actual scraped body to inspect. No-op otherwise.
 */
export function mergeLlmWithRawFallback(
  llmOutput: string,
  rawContent: string | undefined,
): string {
  const reason = detectTerseFailure(llmOutput);
  if (!reason) return llmOutput;
  const trimmed = rawContent?.trim();
  if (!trimmed) return llmOutput;
  const snippet =
    trimmed.length > RAW_FALLBACK_CHAR_CAP
      ? trimmed.slice(0, RAW_FALLBACK_CHAR_CAP) + '\n\n…[raw truncated]'
      : trimmed;
  return `${llmOutput.trim()}\n\n## Raw content (LLM flagged page as ${reason})\n\n${snippet}`;
}

// --- LLM extraction (shared by both branches) ---

async function processItemsWithLlm(
  successItems: ProcessedResult[],
  enhancedInstruction: string | undefined,
  llmProcessor: ReturnType<typeof createLLMProcessor>,
  reporter: ToolReporter,
): Promise<{ items: ProcessedResult[]; llmErrors: number; llmAttempted: number }> {
  let llmErrors = 0;

  // Raw-mode bypass: caller omitted `extract` → return cleaned markdown as-is.
  if (!enhancedInstruction) {
    if (successItems.length > 0) {
      mcpLog('info', 'Raw mode: extract omitted — returning cleaned scraped content without LLM pass', 'scrape');
    }
    return { items: successItems, llmErrors, llmAttempted: 0 };
  }

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
        const merged = mergeLlmWithRawFallback(llmResult.content, item.rawContent);
        if (merged !== llmResult.content) {
          mcpLog('warning', `LLM emitted terse escape line for ${item.url} — preserved raw fallback`, 'scrape');
          void reporter.log('warning', `llm_terse_escape: ${item.url} — preserving raw fallback`);
        }
        return { ...item, content: merged };
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

  const { webInputs, redditInputs, documentInputs, invalidEntries } = partitionUrls(params.urls);
  const validCount = webInputs.length + redditInputs.length + documentInputs.length;

  await reporter.log(
    'info',
    `Partitioned ${params.urls.length} URL(s): ${webInputs.length} web, ${redditInputs.length} reddit, ${documentInputs.length} document, ${invalidEntries.length} invalid`,
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
    `Starting scrape: ${webInputs.length} web + ${redditInputs.length} reddit + ${documentInputs.length} document URL(s)`,
    'scrape',
  );
  await reporter.progress(15, 100, 'Preparing scraper clients');

  // Only initialize the Scrape.do client if we actually have HTML/web URLs.
  // The Jina client is cheap (no auth needed) and always constructed so the
  // document branch and the web→Jina fallback path both work uniformly.
  let clients: ScrapeClients | null = null;
  try {
    const jinaClient = new JinaClient();
    if (webInputs.length > 0) {
      clients = {
        client: new ScraperClient(),
        jinaClient,
        llmProcessor: createLLMProcessor(),
      };
    } else {
      clients = {
        client: null as unknown as ScraperClient,
        jinaClient,
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

  // Only enhance + run LLM when caller supplied an extract instruction.
  // Undefined → raw mode (cleaned markdown returned without LLM pass).
  const enhancedInstruction = params.extract
    ? enhanceExtractionInstruction(params.extract)
    : undefined;

  await reporter.progress(35, 100, 'Fetching page content');

  // Phase 1 — run all three branches in parallel. Failures in one branch do
  // not block the others. The web branch may surface URLs to reroute via
  // `jinaFallbacks` (binary content-type OR non-404 Scrape.do failure),
  // which Phase 2 re-runs through Jina Reader.
  const emptyPhase: WebPhaseResult = {
    successItems: [], failedContents: [],
    metrics: { successful: 0, failed: 0, totalCredits: 0 },
    jinaFallbacks: [],
  };
  const [webPhase, redditPhase, documentPhase] = await Promise.all([
    webInputs.length > 0
      ? fetchWebBranch(webInputs, clients.client)
      : Promise.resolve<WebPhaseResult>(emptyPhase),
    fetchRedditBranch(redditInputs),
    fetchDocumentBranch(documentInputs, clients.jinaClient),
  ]);

  // Phase 2 — Jina Reader as a fallback for web-branch URLs that either
  // returned binary content or failed outright on Scrape.do.
  let deferredPhase: ScrapePhaseResult = {
    successItems: [], failedContents: [],
    metrics: { successful: 0, failed: 0, totalCredits: 0 },
  };
  if (webPhase.jinaFallbacks.length > 0) {
    const binaryCount = webPhase.jinaFallbacks.filter((f) => f.reason === 'binary_content').length;
    const failedCount = webPhase.jinaFallbacks.length - binaryCount;
    await reporter.log(
      'info',
      `Rerouting ${webPhase.jinaFallbacks.length} URL(s) to Jina Reader: ${binaryCount} binary, ${failedCount} scrape-failed`,
    );
    const fallbackInputs: BranchInput[] = webPhase.jinaFallbacks.map((f) => ({
      url: f.url,
      origIndex: f.origIndex,
    }));
    const errorContext = new Map<string, string>(
      webPhase.jinaFallbacks
        .filter((f) => f.scrapeError !== undefined)
        .map((f) => [f.url, f.scrapeError as string]),
    );
    deferredPhase = await fetchDocumentBranch(fallbackInputs, clients.jinaClient, errorContext);
  }

  const successItems = [
    ...webPhase.successItems,
    ...redditPhase.successItems,
    ...documentPhase.successItems,
    ...deferredPhase.successItems,
  ];
  const invalidFailed = invalidEntries.map(
    ({ url }) => `## ${url}\n\n❌ Invalid URL format`,
  );
  const failedContents = [
    ...invalidFailed,
    ...webPhase.failedContents,
    ...redditPhase.failedContents,
    ...documentPhase.failedContents,
    ...deferredPhase.failedContents,
  ];
  const metrics: ScrapeMetrics = {
    successful:
      webPhase.metrics.successful
      + redditPhase.metrics.successful
      + documentPhase.metrics.successful
      + deferredPhase.metrics.successful,
    failed:
      invalidEntries.length
      + webPhase.metrics.failed
      + redditPhase.metrics.failed
      + documentPhase.metrics.failed
      + deferredPhase.metrics.failed,
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
        'Fetch many URLs in parallel. With `extract` set, run per-URL structured LLM extraction (each page returns `## Source`, `## Matches` verbatim facts, `## Not found` gaps, `## Follow-up signals` new terms + referenced URLs); omit `extract` for raw mode (cleaned markdown per URL, no LLM pass). Auto-detects reddit.com post permalinks → Reddit API (threaded post + comments); PDF/DOCX/PPTX/XLSX → Jina Reader; everything else → HTTP scraper. Safe to call in parallel — group URLs by context rather than jamming unrelated batches together. Describe the SHAPE of what you want in `extract`, facets separated by `|` (e.g. `root cause | affected versions | fix | workarounds | timeline`).',
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
