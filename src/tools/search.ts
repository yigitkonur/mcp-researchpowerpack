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
import { createLLMProcessor, classifySearchResults, type ClassificationResult } from '../services/llm-processor.js';
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

// --- Raw output (traditional unified ranked list) ---

function buildRawOutput(
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

// --- Classified output (3-tier LLM-classified table) ---

function buildClassifiedOutput(
  classification: ClassificationResult,
  aggregation: SearchAggregation,
  objective: string,
  totalKeywords: number,
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
  lines.push(`> Objective: ${objective}`);
  lines.push(`> ${totalKeywords} queries → ${rankedUrls.length} URLs → ${tiers.high.length} highly relevant, ${tiers.maybe.length} possibly relevant`);
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
      lines.push(`| ${url.rank} | [${url.title}](${url.url}) | ${url.frequency}/${totalKeywords} (${coveragePct}%) |`);
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
      lines.push(`| ${url.rank} | [${url.title}](${url.url}) | ${url.frequency}/${totalKeywords} (${coveragePct}%) |`);
    }
    lines.push('');
  }

  // Other tier — with keyword attribution
  if (tiers.other.length > 0) {
    lines.push(`### Other Results (${tiers.other.length})`);
    lines.push('| # | URL | Score | Keywords |');
    lines.push('|---|-----|-------|----------|');
    for (const url of tiers.other) {
      const keywords = url.queries.map(q => `"${q}"`).join(', ');
      let domain: string;
      try {
        domain = new URL(url.url).hostname.replace(/^www\./, '');
      } catch {
        domain = url.url;
      }
      lines.push(`| ${url.rank} | ${domain} | ${url.score.toFixed(1)} | ${keywords} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// --- Metadata builder ---

function buildMetadata(
  aggregation: SearchAggregation,
  executionTime: number,
  totalKeywords: number,
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
    return { keyword: s.keyword, result_count: s.results.length, top_url: topDomain };
  });
  const lowYieldKeywords = searches
    .filter(s => s.results.length <= 1)
    .map(s => s.keyword);

  return {
    total_keywords: totalKeywords,
    total_results: aggregation.rankedUrls.length,
    execution_time_ms: executionTime,
    total_unique_urls: aggregation.totalUniqueUrls,
    consensus_url_count: aggregation.rankedUrls.filter(u => u.isConsensus).length,
    frequency_threshold: aggregation.frequencyThreshold,
    llm_classified: llmClassified,
    ...(llmError ? { llm_error: llmError } : {}),
    coverage_summary: coverageSummary,
    ...(lowYieldKeywords.length > 0 ? { low_yield_keywords: lowYieldKeywords } : {}),
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
      'scrape-links(urls=[...], what_to_extract="...") — if you have URLs from prior steps, scrape them now',
    ],
  });

  return toolFailure(
    `${errorContent}\n\nExecution time: ${formatDuration(executionTime)}\nKeywords: ${params.keywords.length}`,
  );
}

// --- Main handler ---

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

    const { aggregation } = processResults(response);
    await reporter.log(
      'info',
      `Collected ${aggregation.totalUniqueUrls} unique URLs across ${response.totalKeywords} queries`,
    );

    // Decide: raw output or LLM classification
    const useRaw = params.raw;
    const llmProcessor = useRaw ? null : createLLMProcessor();

    let markdown: string;
    let llmClassified = false;
    let llmError: string | undefined;

    if (useRaw || !llmProcessor) {
      // Raw path: traditional unified ranked list
      if (!useRaw && !llmProcessor) {
        llmError = 'LLM unavailable (LLM_EXTRACTION_API_KEY not set). Falling back to raw output.';
        mcpLog('warning', llmError, 'search');
      }
      markdown = buildRawOutput(params.keywords, aggregation, response.searches);
      await reporter.progress(80, 100, 'Ranking search results');
    } else {
      // LLM classification path
      await reporter.progress(65, 100, 'Classifying results by relevance');
      const classification = await classifySearchResults(
        aggregation.rankedUrls,
        params.objective,
        response.totalKeywords,
        llmProcessor,
      );

      if (classification.result) {
        markdown = buildClassifiedOutput(
          classification.result, aggregation, params.objective, response.totalKeywords,
        );
        llmClassified = true;
        await reporter.progress(85, 100, 'Formatted classified results');
      } else {
        // Classification failed — fall back to raw
        llmError = classification.error ?? 'Unknown classification error';
        mcpLog('warning', `Classification failed, falling back to raw: ${llmError}`, 'search');
        markdown = buildRawOutput(params.keywords, aggregation, response.searches);
        await reporter.progress(85, 100, 'Classification failed, using raw output');
      }
    }

    const executionTime = Date.now() - startTime;
    const metadata = buildMetadata(
      aggregation, executionTime, response.totalKeywords, response.searches, llmClassified, llmError,
    );

    mcpLog('info', `Search completed: ${aggregation.rankedUrls.length} URLs, classified=${llmClassified}`, 'search');
    await reporter.log('info', `Search completed with ${aggregation.rankedUrls.length} URLs (classified: ${llmClassified})`);

    const footer = `\n---\n*${formatDuration(executionTime)} | ${aggregation.totalUniqueUrls} unique URLs | ${metadata.consensus_url_count} consensus | threshold ≥${aggregation.frequencyThreshold}${llmClassified ? ' | LLM classified' : ''}*`;
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
        'Search Google with 1-100 keywords in parallel. Each keyword runs as a separate search; results are aggregated, deduplicated, and ranked. Provide an objective describing what you need — an LLM classifies every result into 3 tiers (highly relevant / maybe relevant / other) based on titles and snippets alone (no URL fetching). Output: synthesis paragraph + tiered markdown table. Set raw=true to skip classification and get the traditional consensus-ranked URL list.',
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
