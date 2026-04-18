/**
 * Scrape Links Tool Handler
 * Implements robust error handling that NEVER crashes the MCP server
 */

import type { MCPServer } from 'mcp-use/server';

import { SCRAPER, CONCURRENCY, getCapabilities, getMissingEnvMessage } from '../config/index.js';
import {
  scrapeLinksOutputSchema,
  scrapeLinksParamsSchema,
  type ScrapeLinksParams,
  type ScrapeLinksOutput,
} from '../schemas/scrape-links.js';
import { ScraperClient } from '../clients/scraper.js';
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
  TOKEN_BUDGETS,
  calculateTokenAllocation,
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

// Module-level singleton - MarkdownCleaner is stateless
const markdownCleaner = new MarkdownCleaner();

// Extraction prefix/suffix are kept in runtime config to avoid YAML indirection.
function getExtractionPrefix(): string {
  return SCRAPER.EXTRACTION_PREFIX;
}

function getExtractionSuffix(): string {
  return SCRAPER.EXTRACTION_SUFFIX;
}

function enhanceExtractionInstruction(instruction: string | undefined): string {
  const base = instruction || 'Extract the main content and key information from this page.';
  return `${getExtractionPrefix()}\n\n${base}\n\n${getExtractionSuffix()}`;
}

// --- Internal types for decomposed helpers ---

interface ProcessedResult {
  url: string;
  content: string;
  index: number;
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

interface ScrapeClients {
  client: ScraperClient;
  llmProcessor: ReturnType<typeof createLLMProcessor>;
}

// --- Helpers ---

function createScrapeErrorResponse(
  code: string,
  message: string,
  startTime: number,
  totalUrls: number,
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

/** Reddit subdomains that should be routed to get-reddit-post instead. */
const REDDIT_HOST = /(?:^|\.)reddit\.com$/i;

function isRedditUrl(url: string): boolean {
  try {
    return REDDIT_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function validateAndPartitionUrls(urls: string[]): { validUrls: string[]; invalidUrls: string[] } {
  const validUrls: string[] = [];
  const invalidUrls: string[] = [];
  for (const url of urls) {
    try {
      new URL(url);
      validUrls.push(url);
    } catch {
      invalidUrls.push(url);
    }
  }
  return { validUrls, invalidUrls };
}

function initializeScrapeClients(): ScrapeClients {
  const client = new ScraperClient();
  const llmProcessor = createLLMProcessor();
  return { client, llmProcessor };
}

function processScrapeResults(
  results: Awaited<ReturnType<ScraperClient['scrapeMultiple']>>,
  invalidUrls: string[],
): ScrapePhaseResult {
  const successItems: ProcessedResult[] = [];
  const failedContents: string[] = [];
  let successful = 0;
  let failed = 0;
  let totalCredits = 0;

  for (const invalidUrl of invalidUrls) {
    failed++;
    failedContents.push(`## ${invalidUrl}\n\n❌ Invalid URL format`);
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) {
      failed++;
      failedContents.push(`## Unknown URL\n\n❌ No result returned`);
      continue;
    }

    mcpLog('debug', `[${i + 1}/${results.length}] Processing ${result.url}`, 'scrape');

    if (result.error || result.statusCode < 200 || result.statusCode >= 300) {
      failed++;
      const errorMsg = result.error?.message || result.content || `HTTP ${result.statusCode}`;
      failedContents.push(`## ${result.url}\n\n❌ Failed to scrape: ${errorMsg}`);
      mcpLog('warning', `[${i + 1}/${results.length}] Failed: ${errorMsg}`, 'scrape');
      continue;
    }

    successful++;
    totalCredits += result.credits;

    // Strip HTML chrome (cookie banners, nav, footer, repeated hero blocks)
    // BEFORE LLM extraction. Same pipeline applies to the raw fallback.
    // See: docs/code-review/context/02-current-tool-surface.md (E5).
    let content: string;
    try {
      const readable = extractReadableContent(result.content, result.url);
      const sourceForCleaner = readable.extracted ? readable.content : result.content;
      content = markdownCleaner.processContent(sourceForCleaner);
    } catch {
      content = result.content;
    }

    successItems.push({ url: result.url, content, index: i });
  }

  return { successItems, failedContents, metrics: { successful, failed, totalCredits } };
}

async function processItemsWithLlm(
  successItems: ProcessedResult[],
  enhancedInstruction: string,
  tokensPerUrl: number,
  llmProcessor: ReturnType<typeof createLLMProcessor>,
  reporter: ToolReporter,
): Promise<{ items: ProcessedResult[]; llmErrors: number; llmAttempted: number }> {
  let llmErrors = 0;

  if (!llmProcessor || successItems.length === 0) {
    if (!llmProcessor && successItems.length > 0) {
      mcpLog('warning', 'LLM unavailable (LLM_EXTRACTION_API_KEY not set). Returning raw scraped content.', 'scrape');
      // Surface degraded mode to the client. See:
      //   mcp-revisions/llm-degradation/01-signal-degraded-via-ctx-log.md
      void reporter.log('warning', 'llm_extractor_unreachable: planner not configured; raw scraped content returned');
    }
    return { items: successItems, llmErrors, llmAttempted: 0 };
  }

  mcpLog('info', `Starting parallel LLM extraction for ${successItems.length} pages (concurrency: ${CONCURRENCY.LLM_EXTRACTION})`, 'scrape');

  const llmResults = await pMap(successItems, async (item) => {
    mcpLog('debug', `LLM extracting ${item.url} (${tokensPerUrl} tokens)...`, 'scrape');

    const llmResult = await processContentWithLLM(
      item.content,
      { enabled: true, extract: enhancedInstruction, max_tokens: tokensPerUrl, url: item.url },
      llmProcessor,
    );

    if (llmResult.processed) {
      mcpLog('debug', `LLM extraction complete for ${item.url}`, 'scrape');
      return { ...item, content: llmResult.content };
    }

    llmErrors++;
    mcpLog('warning', `LLM extraction failed for ${item.url}: ${llmResult.error || 'unknown reason'}`, 'scrape');
    void reporter.log('warning', `llm_extractor_unreachable: ${item.url} — ${llmResult.error || 'unknown reason'}`);
    return item;
  }, CONCURRENCY.LLM_EXTRACTION);

  return { items: llmResults, llmErrors, llmAttempted: successItems.length };
}

function assembleContentEntries(successItems: ProcessedResult[], failedContents: string[]): string[] {
  const contents = [...failedContents];
  for (const item of successItems) {
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

function buildScrapeMetadata(
  params: ScrapeLinksParams,
  metrics: ScrapeMetrics,
  tokensPerUrl: number,
  totalBatches: number,
  executionTime: number,
): ScrapeLinksOutput['metadata'] {
  return {
    total_items: params.urls.length,
    successful: metrics.successful,
    failed: metrics.failed,
    execution_time_ms: executionTime,
    total_credits: metrics.totalCredits,
  };
}

function buildScrapeResponse(
  params: ScrapeLinksParams,
  contents: string[],
  metrics: ScrapeMetrics,
  tokensPerUrl: number,
  totalBatches: number,
  llmErrors: number,
  executionTime: number,
  llmAccounting: { llmAttempted: number; llmSucceeded: boolean },
): { content: string; structuredContent: ScrapeLinksOutput } {
  // Be explicit about LLM accounting: how many URLs the LLM tried, how many
  // succeeded, and whether the pass produced any value. Without this, the
  // batch header reports `Successful: N + LLM extraction failures: N` and the
  // caller can't tell whether the credits charged for the LLM pass produced
  // anything.
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
    tokensPerItem: tokensPerUrl,
    batches: totalBatches,
    extras: {
      'Credits used': metrics.totalCredits,
      ...llmExtras,
    },
  });

  // No cookie-cutter "Next Steps" with literal `[...]` placeholders. The
  // server omits the Next Steps block when there are no concrete suggestions
  // to make. See: docs/code-review/context/07-derailment-evidence.md
  // ([FOOTER-BAD]) and mcp-revisions/output-shaping/05.
  const formattedContent = formatSuccess({
    title: 'Scraping Complete',
    summary: batchHeader,
    data: contents.join('\n\n---\n\n'),
    metadata: {
      'Execution time': formatDuration(executionTime),
      'Token budget': TOKEN_BUDGETS.SCRAPER.toLocaleString(),
    },
  });

  const metadata = buildScrapeMetadata(params, metrics, tokensPerUrl, totalBatches, executionTime);
  return { content: formattedContent, structuredContent: { content: formattedContent, metadata } };
}

/**
 * Handle scrape links request
 * NEVER throws - always returns a valid response with content and metadata
 */
export async function handleScrapeLinks(
  params: ScrapeLinksParams,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<ScrapeLinksOutput>> {
  const startTime = Date.now();

  if (!params.urls || params.urls.length === 0) {
    return createScrapeErrorResponse('NO_URLS', 'No URLs provided', startTime, params.urls?.length || 0);
  }

  // Reddit URLs are structurally different (threaded comments, SPA shell,
  // Cloudflare-fronted JSON API). Reject the entire batch so the caller
  // re-routes to get-reddit-post — silent partial-routing is the
  // [FOOTER-BAD] / [REDUNDANT] anti-pattern from the derailment evidence.
  // See: mcp-revisions/tool-surface/03-reddit-url-routing-in-scrape-links.md
  const redditUrls = params.urls.filter(isRedditUrl);
  if (redditUrls.length > 0) {
    return createScrapeErrorResponse(
      'UNSUPPORTED_URL_TYPE',
      `scrape-links does not support Reddit URLs. Use get-reddit-post for: ${redditUrls.join(', ')}`,
      startTime,
      params.urls.length,
      false,
      [
        `get-reddit-post(urls=[${redditUrls.map((u) => `"${u}"`).join(', ')}]) — fetch threaded posts and comments directly`,
        'web-search(queries=["..."], extract="...", scope: "reddit") — find Reddit post permalinks first if these URLs were guesses',
      ],
    );
  }

  const { validUrls, invalidUrls } = validateAndPartitionUrls(params.urls);
  await reporter.log('info', `Validated ${validUrls.length} scrapeable URL(s) and ${invalidUrls.length} invalid URL(s)`);

  if (validUrls.length === 0) {
    return createScrapeErrorResponse('INVALID_URLS', `All ${params.urls.length} URLs are invalid`, startTime, params.urls.length, false, [
      'web-search(queries=["topic documentation", "topic guide"], extract="relevant documentation and guides") — search for valid URLs first, then scrape the results',
      'web-search(queries=["topic recommendations"], extract="...", scope: "reddit") — find Reddit discussion permalinks to feed get-reddit-post instead',
    ]);
  }

  const tokensPerUrl = calculateTokenAllocation(validUrls.length, TOKEN_BUDGETS.SCRAPER);
  const totalBatches = Math.ceil(validUrls.length / SCRAPER.BATCH_SIZE);

  mcpLog('info', `Starting scrape: ${validUrls.length} URL(s), ${tokensPerUrl} tokens/URL, ${totalBatches} batch(es)`, 'scrape');
  await reporter.progress(15, 100, 'Preparing scraper clients');

  let clients: ScrapeClients;
  try {
    clients = initializeScrapeClients();
  } catch (error) {
    const err = classifyError(error);
    return createScrapeErrorResponse('CLIENT_INIT_FAILED', `Failed to initialize scraper: ${err.message}`, startTime, params.urls.length, false, [
      'web-search(queries=["topic key findings", "topic summary", "topic overview"], extract="key findings and summary") — search for information instead of scraping',
      'web-search(queries=["topic discussion", "topic recommendations"], extract="...", scope: "reddit") — get community insights as an alternative',
    ]);
  }

  const enhancedInstruction = enhanceExtractionInstruction(params.extract);

  await reporter.progress(35, 100, 'Fetching page content');
  const results = await clients.client.scrapeMultiple(validUrls, { timeout: 60 });
  mcpLog('info', `Scraping complete. Processing ${results.length} results...`, 'scrape');
  await reporter.log('info', `Fetched ${results.length} scrape response(s) from the provider`);
  await reporter.progress(60, 100, 'Cleaning and classifying scrape results');

  const { successItems, failedContents, metrics } = processScrapeResults(results, invalidUrls);

  if (successItems.length > 0) {
    await reporter.progress(80, 100, 'Running LLM extraction over scraped pages');
  }
  const { items: processedItems, llmErrors, llmAttempted } = await processItemsWithLlm(
    successItems, enhancedInstruction, tokensPerUrl, clients.llmProcessor, reporter,
  );

  const contents = assembleContentEntries(processedItems, failedContents);
  const executionTime = Date.now() - startTime;

  mcpLog('info', `Completed: ${metrics.successful} successful, ${metrics.failed} failed, ${metrics.totalCredits} credits used`, 'scrape');
  await reporter.log(
    'info',
    `Scrape completed with ${metrics.successful} success(es), ${metrics.failed} failure(s), and ${llmErrors} LLM extraction issue(s)`,
  );

  // Credit policy: when LLM was attempted but every URL failed extraction,
  // we still report the failures but make the credit reality explicit in
  // the batch header so callers don't see "credits used" without knowing
  // they paid for a no-op LLM pass. See:
  //   mcp-revisions/llm-degradation/03-extraction-failure-credit-policy.md
  const llmSucceeded = llmAttempted > 0 && llmErrors < llmAttempted;
  const result = buildScrapeResponse(
    params,
    contents,
    metrics,
    tokensPerUrl,
    totalBatches,
    llmErrors,
    executionTime,
    { llmAttempted, llmSucceeded },
  );

  // Contract: every URL failed → return isError: true so callers that check
  // response.isError can short-circuit. Partial success still resolves
  // through toolSuccess so the agent sees both rows. See
  // docs/code-review/context/02-current-tool-surface.md (E6).
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
        'Scrape many web pages in parallel and run structured LLM extraction on each (no hard cap). Per-page output: `## Source` (URL + detected page type + date), `## Matches` (verbatim-preserved facts), `## Not found` (explicit gaps the page did not answer — kills hallucination), `## Follow-up signals` (new terms and referenced-but-unscraped URLs that feed the next research loop), optional `## Contradictions` and `## Truncation` footers. Extraction behavior adapts per page type (docs, github-thread, reddit, marketing, cve, paper, announcement, qa, blog, changelog, release-notes). Use the `extract` field to describe the shape of what you want, separated by `|`.',
      schema: scrapeLinksParamsSchema,
      outputSchema: scrapeLinksOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
        // See contract-fixes/03 — non-standard precondition hint.
        ...({ experimental: { requires: ['start-research'] } } as Record<string, unknown>),
      },
      _meta: { requires: ['start-research'] },
    },
    async (args, ctx) => {
      if (!getCapabilities().scraping) {
        return toToolResponse(toolFailure(getMissingEnvMessage('scraping')));
      }

      const guard = await requireBootstrap(ctx);
      if (guard) {
        return guard;
      }

      const reporter = createToolReporter(ctx, 'scrape-links');
      const result = await handleScrapeLinks(args, reporter);

      await reporter.progress(100, 100, result.isError ? 'Scrape failed' : 'Scrape complete');
      return toToolResponse(result);
    },
  );
}
