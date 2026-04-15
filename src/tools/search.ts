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
import {
  createLLMProcessor,
  classifySearchResults,
  suggestRefineQueriesForRawMode,
  type ClassificationResult,
  type RefineQuerySuggestion,
} from '../services/llm-processor.js';
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
import { requireBootstrap } from '../utils/bootstrap-guard.js';
import { redditKeywordGuard } from '../utils/reddit-keyword-guard.js';
import { sanitizeSuggestion } from '../utils/sanitize.js';

// --- Internal types ---

interface SearchAggregation {
  readonly rankedUrls: ReturnType<typeof aggregateAndRank>['rankedUrls'];
  readonly totalUniqueUrls: number;
  readonly frequencyThreshold: number;
  readonly thresholdNote?: string;
}

interface SearchResponse {
  searches: Parameters<typeof aggregateAndRank>[0];
  totalQueries: number;
}

// --- Helpers ---

async function executeSearches(queries: string[]): Promise<SearchResponse> {
  const client = new SearchClient();
  return client.searchMultiple(queries);
}

function processResults(response: SearchResponse): {
  aggregation: SearchAggregation;
} {
  const aggregation = aggregateAndRank(response.searches, 5);
  return { aggregation };
}

// --- Raw output (traditional unified ranked list) ---

function buildRawOutput(
  queries: string[],
  aggregation: SearchAggregation,
  searches: SearchResponse['searches'],
): string {
  return generateUnifiedOutput(
    aggregation.rankedUrls, queries, searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold, aggregation.thresholdNote,
  );
}

function buildSignalsSection(
  aggregation: SearchAggregation,
  searches: SearchResponse['searches'],
  totalQueries: number,
): string {
  const coverageCount = searches.filter((search) => search.results.length >= 3).length;
  const lowYield = searches
    .filter((search) => search.results.length <= 1)
    .map((search) => `"${search.query}"`);
  const consensusCount = aggregation.rankedUrls.filter((url) => url.isConsensus).length;

  const lines = [
    '**Signals**',
    `- Coverage: ${coverageCount}/${totalQueries} queries returned ≥3 results`,
    `- Consensus URLs: ${consensusCount}`,
  ];

  if (lowYield.length > 0) {
    lines.push(`- Low-yield: ${lowYield.join(', ')}`);
  }

  return lines.join('\n');
}

export function buildSuggestedFollowUpsSection(
  refineQueries: Array<{ query: string; rationale: string }> | undefined,
): string {
  if (!refineQueries || refineQueries.length === 0) {
    return '';
  }

  const lines = ['## Suggested follow-up searches', ''];

  for (const item of refineQueries) {
    lines.push(`- ${sanitizeSuggestion(item.query)} — ${sanitizeSuggestion(item.rationale)}`);
  }

  return lines.join('\n');
}

export function appendSignalsAndFollowUps(
  markdown: string,
  signalsSection: string,
  refineQueries: RefineQuerySuggestion[] | undefined,
): string {
  const sections = [markdown, '', '---', signalsSection];
  const followUps = buildSuggestedFollowUpsSection(refineQueries);
  if (followUps) {
    sections.push('', followUps);
  }
  return sections.join('\n');
}

// --- Classified output (3-tier LLM-classified table) ---

function buildClassifiedOutput(
  classification: ClassificationResult,
  aggregation: SearchAggregation,
  extract: string,
  searches: SearchResponse['searches'],
  totalQueries: number,
): string {
  const rankedUrls = aggregation.rankedUrls;

  // Build lookup from rank → url data
  const urlByRank = new Map(rankedUrls.map(u => [u.rank, u]));

  // Build tier → entries mapping
  const tiers = {
    high: [] as typeof rankedUrls,
    maybe: [] as typeof rankedUrls,
    other: [] as typeof rankedUrls,
  };

  // Classify based on LLM response
  const tierMap = new Map(classification.results.map(r => [r.rank, r.tier]));

  for (const url of rankedUrls) {
    const tier = tierMap.get(url.rank);
    if (tier === 'HIGHLY_RELEVANT') {
      tiers.high.push(url);
    } else if (tier === 'MAYBE_RELEVANT') {
      tiers.maybe.push(url);
    } else {
      tiers.other.push(url);
    }
  }

  const lines: string[] = [];

  // Header with generated title and synthesis
  lines.push(`## ${classification.title}`);
  lines.push(`> Looking for: ${extract}`);
  lines.push(`> ${totalQueries} queries → ${rankedUrls.length} URLs → ${tiers.high.length} highly relevant, ${tiers.maybe.length} possibly relevant`);
  lines.push('');
  lines.push(`**Summary:** ${classification.synthesis}`);
  lines.push('');

  // Highly Relevant tier
  if (tiers.high.length > 0) {
    lines.push(`### Highly Relevant (${tiers.high.length})`);
    lines.push('| # | URL | Seen in |');
    lines.push('|---|-----|---------|');
    for (const url of tiers.high) {
      const coveragePct = Math.round(url.coverageRatio * 100);
      const queries = url.queries.map(q => `"${q}"`).join(', ');
      lines.push(`| ${url.rank} | [${url.title}](${url.url}) | ${url.frequency}/${totalQueries} (${coveragePct}%) |`);
    }
    lines.push('');
  }

  // Maybe Relevant tier
  if (tiers.maybe.length > 0) {
    lines.push(`### Maybe Relevant (${tiers.maybe.length})`);
    lines.push('| # | URL | Seen in |');
    lines.push('|---|-----|---------|');
    for (const url of tiers.maybe) {
      const coveragePct = Math.round(url.coverageRatio * 100);
      lines.push(`| ${url.rank} | [${url.title}](${url.url}) | ${url.frequency}/${totalQueries} (${coveragePct}%) |`);
    }
    lines.push('');
  }

  // Other tier — with query attribution
  if (tiers.other.length > 0) {
    lines.push(`### Other Results (${tiers.other.length})`);
    lines.push('| # | URL | Score | Queries |');
    lines.push('|---|-----|-------|----------|');
    for (const url of tiers.other) {
      const queryList = url.queries.map(q => `"${q}"`).join(', ');
      let domain: string;
      try {
        domain = new URL(url.url).hostname.replace(/^www\./, '');
      } catch {
        domain = url.url;
      }
      lines.push(`| ${url.rank} | ${domain} | ${url.score.toFixed(1)} | ${queryList} |`);
    }
    lines.push('');
  }

  lines.push(buildSignalsSection(aggregation, searches, totalQueries));

  const followUps = buildSuggestedFollowUpsSection(classification.refine_queries);
  if (followUps) {
    lines.push('');
    lines.push(followUps);
  }

  return lines.join('\n');
}

// --- Metadata builder ---

function buildMetadata(
  aggregation: SearchAggregation,
  executionTime: number,
  totalQueries: number,
  searches: SearchResponse['searches'],
  llmClassified: boolean,
  llmError?: string,
) {
  const coverageSummary = searches.map(s => {
    let topDomain: string | undefined;
    const topResult = s.results[0];
    if (topResult) {
      try { topDomain = new URL(topResult.link).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    }
    return { query: s.query, result_count: s.results.length, top_url: topDomain };
  });
  const lowYieldQueries = searches
    .filter(s => s.results.length <= 1)
    .map(s => s.query);

  return {
    total_items: totalQueries,
    successful: aggregation.rankedUrls.length,
    failed: totalQueries - searches.filter(s => s.results.length > 0).length,
    execution_time_ms: executionTime,
    llm_classified: llmClassified,
    ...(llmError ? { llm_error: llmError } : {}),
    coverage_summary: coverageSummary,
    ...(lowYieldQueries.length > 0 ? { low_yield_queries: lowYieldQueries } : {}),
  };
}

// --- Error builder ---

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
      'search-reddit(queries=["topic recommendations"]) — returns Reddit URLs via Google search',
      'scrape-links(urls=[...], extract="...") — if you have URLs from prior steps, scrape them now',
    ],
  });

  return toolFailure(
    `${errorContent}\n\nExecution time: ${formatDuration(executionTime)}\nQueries: ${params.queries.length}`,
  );
}

// --- Main handler ---

export async function handleWebSearch(
  params: WebSearchParams,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<WebSearchOutput>> {
  const startTime = Date.now();

  try {
    mcpLog('info', `Searching for ${params.queries.length} query/queries`, 'search');
    await reporter.log('info', `Searching for ${params.queries.length} query/queries`);
    await reporter.progress(15, 100, 'Submitting search queries');

    const response = await executeSearches(params.queries);
    await reporter.progress(50, 100, 'Collected search results');

    const { aggregation } = processResults(response);
    await reporter.log(
      'info',
      `Collected ${aggregation.totalUniqueUrls} unique URLs across ${response.totalQueries} queries`,
    );

    // Decide: raw output or LLM classification
    const useRaw = params.raw;
    const llmProcessor = createLLMProcessor();

    let markdown: string;
    let llmClassified = false;
    let llmError: string | undefined;

    if (useRaw || !llmProcessor) {
      // Raw path: traditional unified ranked list
      if (!useRaw && !llmProcessor) {
        llmError = 'LLM unavailable (LLM_EXTRACTION_API_KEY not set). Falling back to raw output.';
        mcpLog('warning', llmError, 'search');
      }
      let rawRefineQueries: RefineQuerySuggestion[] | undefined;
      if (useRaw && llmProcessor) {
        const refineResult = await suggestRefineQueriesForRawMode(
          aggregation.rankedUrls,
          params.extract,
          params.queries,
          llmProcessor,
        );
        rawRefineQueries = refineResult.result;
      }
      markdown = appendSignalsAndFollowUps(
        buildRawOutput(params.queries, aggregation, response.searches),
        buildSignalsSection(aggregation, response.searches, response.totalQueries),
        rawRefineQueries,
      );
      await reporter.progress(80, 100, 'Ranking search results');
    } else {
      // LLM classification path
      await reporter.progress(65, 100, 'Classifying results by relevance');
      const classification = await classifySearchResults(
        aggregation.rankedUrls,
        params.extract,
        response.totalQueries,
        llmProcessor,
      );

      if (classification.result) {
        markdown = buildClassifiedOutput(
          classification.result, aggregation, params.extract, response.searches, response.totalQueries,
        );
        llmClassified = true;
        await reporter.progress(85, 100, 'Formatted classified results');
      } else {
        // Classification failed — fall back to raw
        llmError = classification.error ?? 'Unknown classification error';
        mcpLog('warning', `Classification failed, falling back to raw: ${llmError}`, 'search');
        markdown = appendSignalsAndFollowUps(
          buildRawOutput(params.queries, aggregation, response.searches),
          buildSignalsSection(aggregation, response.searches, response.totalQueries),
          undefined,
        );
        await reporter.progress(85, 100, 'Classification failed, using raw output');
      }
    }

    const executionTime = Date.now() - startTime;
    const metadata = buildMetadata(
      aggregation, executionTime, response.totalQueries, response.searches, llmClassified, llmError,
    );

    mcpLog('info', `Search completed: ${aggregation.rankedUrls.length} URLs, classified=${llmClassified}`, 'search');
    await reporter.log('info', `Search completed with ${aggregation.rankedUrls.length} URLs (classified: ${llmClassified})`);

    const footer = `\n---\n*${formatDuration(executionTime)} | ${aggregation.totalUniqueUrls} unique URLs${llmClassified ? ' | LLM classified' : ''}*`;
    const fullMarkdown = markdown + footer;

    return toolSuccess(fullMarkdown, { content: fullMarkdown, metadata });
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
        'Run up to 100 Google searches in parallel, aggregate and deduplicate results, then classify each URL by relevance to your extract goal. Returns a tiered table: highly relevant, maybe relevant, and other. Set raw=true for unclassified ranked results.',
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

      const guard = await requireBootstrap(ctx);
      if (guard) {
        return guard;
      }

      const redditGuard = await redditKeywordGuard(ctx, args.queries);
      if (redditGuard) {
        return redditGuard;
      }

      const reporter = createToolReporter(ctx, 'web-search');
      const result = await handleWebSearch(args, reporter);

      await reporter.progress(100, 100, result.isError ? 'Search failed' : 'Search complete');
      return toToolResponse(result);
    },
  );
}
