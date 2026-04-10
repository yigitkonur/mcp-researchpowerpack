/**
 * Web Search Tool Handler
 * NEVER throws - always returns structured response for graceful degradation
 */

import type { MCPServer } from 'mcp-use/server';

import { getCapabilities, getMissingEnvMessage } from '../config/index.js';
import {
  webSearchOutputSchema,
  webSearchParamsSchema,
  type WebSearchParams,
  type WebSearchOutput,
} from '../schemas/web-search.js';
import { SearchClient } from '../clients/search.js';
import {
  aggregateAndRank,
  generateUnifiedOutput,
} from '../utils/url-aggregator.js';
import { classifyError } from '../utils/errors.js';
import {
  mcpLog,
  formatError,
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

// --- Internal types ---

interface SearchAggregation {
  readonly rankedUrls: ReturnType<typeof aggregateAndRank>['rankedUrls'];
  readonly totalUniqueUrls: number;
  readonly frequencyThreshold: number;
  readonly thresholdNote?: string;
}

interface SearchResponse {
  searches: Parameters<typeof aggregateAndRank>[0];
  totalKeywords: number;
}

// --- Helpers ---

async function executeSearches(keywords: string[]): Promise<SearchResponse> {
  const client = new SearchClient();
  return client.searchMultiple(keywords);
}

function processResults(response: SearchResponse): {
  aggregation: SearchAggregation;
  consensusUrls: SearchAggregation['rankedUrls'];
} {
  const aggregation = aggregateAndRank(response.searches, 5);
  const consensusUrls = aggregation.rankedUrls.filter(u => u.isConsensus);
  return { aggregation, consensusUrls };
}

function buildOutputMarkdown(
  keywords: string[],
  aggregation: SearchAggregation,
  searches: SearchResponse['searches'],
): string {
  return generateUnifiedOutput(
    aggregation.rankedUrls, keywords, searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold, aggregation.thresholdNote,
  );
}

function formatSearchOutput(
  outputMarkdown: string,
  aggregation: SearchAggregation,
  consensusUrlCount: number,
  executionTime: number,
  totalKeywords: number,
  searches: SearchResponse['searches'],
): ToolExecutionResult<WebSearchOutput> {
  const markdown = outputMarkdown + `\n---\n*${formatDuration(executionTime)} | ${aggregation.totalUniqueUrls} unique URLs | ${consensusUrlCount} consensus | threshold ≥${aggregation.frequencyThreshold}*`;

  const coverageSummary = searches.map(s => {
    let topDomain: string | undefined;
    const topResult = s.results[0];
    if (topResult) {
      try { topDomain = new URL(topResult.link).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    }
    return { keyword: s.keyword, result_count: s.results.length, top_url: topDomain };
  });
  const lowYieldKeywords = searches
    .filter(s => s.results.length <= 1)
    .map(s => s.keyword);

  const metadata = {
    total_keywords: totalKeywords,
    total_results: aggregation.rankedUrls.length,
    execution_time_ms: executionTime,
    total_unique_urls: aggregation.totalUniqueUrls,
    consensus_url_count: consensusUrlCount,
    frequency_threshold: aggregation.frequencyThreshold,
    coverage_summary: coverageSummary,
    ...(lowYieldKeywords.length > 0 ? { low_yield_keywords: lowYieldKeywords } : {}),
  };

  return toolSuccess(markdown, { content: markdown, metadata });
}

function buildWebSearchError(
  error: unknown,
  params: WebSearchParams,
  startTime: number,
): ToolExecutionResult<WebSearchOutput> {
  const structuredError = classifyError(error);
  const executionTime = Date.now() - startTime;

  mcpLog('error', `web-search: ${structuredError.message}`, 'search');

  const errorContent = formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'web-search',
    howToFix: ['Verify SERPER_API_KEY is set correctly'],
    alternatives: [
      'search-reddit(queries=["topic recommendations", "topic best practices", "topic vs alternatives"]) — Reddit search uses the same API but may work; also provides community perspective',
      'scrape-links(urls=[...any URLs you already have...], use_llm=true) — if you have URLs from prior steps, scrape them now instead of searching',
    ],
  });

  return toolFailure(
    `${errorContent}\n\nExecution time: ${formatDuration(executionTime)}\nKeywords: ${params.keywords.length}`,
  );
}

export async function handleWebSearch(
  params: WebSearchParams,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<WebSearchOutput>> {
  const startTime = Date.now();

  try {
    mcpLog('info', `Searching for ${params.keywords.length} keyword(s)`, 'search');
    await reporter.log('info', `Searching for ${params.keywords.length} keyword(s)`);
    await reporter.progress(15, 100, 'Submitting search queries');

    const response = await executeSearches(params.keywords);
    await reporter.progress(50, 100, 'Collected search results');

    const { aggregation, consensusUrls } = processResults(response);
    await reporter.log(
      'info',
      `Collected ${aggregation.totalUniqueUrls} unique URLs across ${response.totalKeywords} queries`,
    );

    const outputMarkdown = buildOutputMarkdown(params.keywords, aggregation, response.searches);
    await reporter.progress(80, 100, 'Ranking and formatting search results');

    const executionTime = Date.now() - startTime;
    mcpLog('info', `Search completed: ${aggregation.rankedUrls.length} unique URLs, ${consensusUrls.length} consensus`, 'search');
    await reporter.log(
      'info',
      `Search completed with ${aggregation.rankedUrls.length} ranked URLs and ${consensusUrls.length} consensus`,
    );

    return formatSearchOutput(
      outputMarkdown, aggregation, consensusUrls.length, executionTime, response.totalKeywords, response.searches,
    );
  } catch (error) {
    return buildWebSearchError(error, params, startTime);
  }
}

export function registerWebSearchTool(server: MCPServer): void {
  server.tool(
    {
      name: 'web-search',
      title: 'Web Search',
      description:
        'Run parallel Google searches across 1–100 keywords and return CTR-weighted, consensus-ranked URLs for follow-up scraping. This is a bulk discovery tool — supply 3–7 keywords for solid consensus detection, or up to 100 for exhaustive coverage. Each keyword runs as a separate Google search; results are aggregated, scored by search position, and URLs appearing across multiple queries are flagged as high-confidence. Output is a ranked URL list ready to pipe into scrape-links or get-reddit-post.',
      schema: webSearchParamsSchema,
      outputSchema: webSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      if (!getCapabilities().search) {
        return toToolResponse(toolFailure(getMissingEnvMessage('search')));
      }

      const reporter = createToolReporter(ctx, 'web-search');
      const result = await handleWebSearch(args, reporter);

      await reporter.progress(100, 100, result.isError ? 'Search failed' : 'Search complete');
      return toToolResponse(result);
    },
  );
}
