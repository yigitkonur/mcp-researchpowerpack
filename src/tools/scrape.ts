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

    let content: string;
    try {
      content = markdownCleaner.processContent(result.content);
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
): Promise<{ items: ProcessedResult[]; llmErrors: number }> {
  let llmErrors = 0;

  if (!llmProcessor || successItems.length === 0) {
    if (!llmProcessor && successItems.length > 0) {
      mcpLog('warning', 'LLM unavailable (LLM_EXTRACTION_API_KEY not set). Returning raw scraped content.', 'scrape');
    }
    return { items: successItems, llmErrors };
  }

  mcpLog('info', `Starting parallel LLM extraction for ${successItems.length} pages (concurrency: ${CONCURRENCY.LLM_EXTRACTION})`, 'scrape');

  const llmResults = await pMap(successItems, async (item) => {
    mcpLog('debug', `LLM extracting ${item.url} (${tokensPerUrl} tokens)...`, 'scrape');

    const llmResult = await processContentWithLLM(
      item.content,
      { use_llm: true, what_to_extract: enhancedInstruction, max_tokens: tokensPerUrl },
      llmProcessor,
    );

    if (llmResult.processed) {
      mcpLog('debug', `LLM extraction complete for ${item.url}`, 'scrape');
      return { ...item, content: llmResult.content };
    }

    llmErrors++;
    mcpLog('warning', `LLM extraction failed for ${item.url}: ${llmResult.error || 'unknown reason'}`, 'scrape');
    return item;
  }, CONCURRENCY.LLM_EXTRACTION);

  return { items: llmResults, llmErrors };
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
    total_urls: params.urls.length,
    successful: metrics.successful,
    failed: metrics.failed,
    total_credits: metrics.totalCredits,
    execution_time_ms: executionTime,
    tokens_per_url: tokensPerUrl,
    total_token_budget: TOKEN_BUDGETS.SCRAPER,
    batches_processed: totalBatches,
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
): { content: string; structuredContent: ScrapeLinksOutput } {
  const batchHeader = formatBatchHeader({
    title: `Scraped Content (${params.urls.length} URLs)`,
    totalItems: params.urls.length,
    successful: metrics.successful,
    failed: metrics.failed,
    tokensPerItem: tokensPerUrl,
    batches: totalBatches,
    extras: {
      'Credits used': metrics.totalCredits,
      ...(llmErrors > 0 ? { 'LLM extraction failures': llmErrors } : {}),
    },
  });

  const formattedContent = formatSuccess({
    title: 'Scraping Complete',
    summary: batchHeader,
    data: contents.join('\n\n---\n\n'),
    nextSteps: [
      metrics.successful > 0 ? 'web-search or search-reddit to cross-check claims from scraped content' : null,
      metrics.failed > 0 ? 'Retry failed URLs with timeout=60' : null,
    ].filter(Boolean) as string[],
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

  const { validUrls, invalidUrls } = validateAndPartitionUrls(params.urls);
  await reporter.log('info', `Validated ${validUrls.length} scrapeable URL(s) and ${invalidUrls.length} invalid URL(s)`);

  if (validUrls.length === 0) {
    return createScrapeErrorResponse('INVALID_URLS', `All ${params.urls.length} URLs are invalid`, startTime, params.urls.length, false, [
      'web-search(keywords=["topic documentation", "topic guide"]) — search for valid URLs first, then scrape the results',
      'search-reddit(queries=["topic recommendations"]) — find discussion URLs to scrape instead',
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
      'web-search(keywords=["topic key findings", "topic summary", "topic overview"]) — search for information instead of scraping',
      'search-reddit(queries=["topic discussion", "topic recommendations"]) — get community insights as an alternative',
    ]);
  }

  const enhancedInstruction = enhanceExtractionInstruction(params.what_to_extract);

  await reporter.progress(35, 100, 'Fetching page content');
  const results = await clients.client.scrapeMultiple(validUrls, { timeout: params.timeout });
  mcpLog('info', `Scraping complete. Processing ${results.length} results...`, 'scrape');
  await reporter.log('info', `Fetched ${results.length} scrape response(s) from the provider`);
  await reporter.progress(60, 100, 'Cleaning and classifying scrape results');

  const { successItems, failedContents, metrics } = processScrapeResults(results, invalidUrls);

  if (successItems.length > 0) {
    await reporter.progress(80, 100, 'Running LLM extraction over scraped pages');
  }
  const { items: processedItems, llmErrors } = await processItemsWithLlm(
    successItems, enhancedInstruction, tokensPerUrl, clients.llmProcessor,
  );

  const contents = assembleContentEntries(processedItems, failedContents);
  const executionTime = Date.now() - startTime;

  mcpLog('info', `Completed: ${metrics.successful} successful, ${metrics.failed} failed, ${metrics.totalCredits} credits used`, 'scrape');
  await reporter.log(
    'info',
    `Scrape completed with ${metrics.successful} success(es), ${metrics.failed} failure(s), and ${llmErrors} LLM extraction issue(s)`,
  );

  const result = buildScrapeResponse(
    params,
    contents,
    metrics,
    tokensPerUrl,
    totalBatches,
    llmErrors,
    executionTime,
  );
  return toolSuccess(result.content, result.structuredContent);
}

export function registerScrapeLinksTool(server: MCPServer): void {
  server.tool(
    {
      name: 'scrape-links',
      title: 'Scrape Links',
      description:
        'Scrape 1-50 web pages and run LLM extraction on each. Provide what_to_extract with specific targets (e.g., "Extract pricing tiers | feature limits | API rate limits"). Token budget (32K) is split across URLs: 3 URLs get ~10K tokens each (deep), 10 get ~3K (balanced), 50 get ~640 (scan).',
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
