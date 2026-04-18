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
  verbose: boolean = false,
): string {
  return generateUnifiedOutput(
    aggregation.rankedUrls, queries, searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold, aggregation.thresholdNote,
    verbose,
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
  refineQueries: Array<{ query: string; rationale?: string; gap_id?: number; gap_description?: string }> | undefined,
): string {
  if (!refineQueries || refineQueries.length === 0) {
    return '';
  }

  const lines = ['## Suggested follow-up searches', ''];

  for (const item of refineQueries) {
    const query = sanitizeSuggestion(item.query ?? '');
    if (!query) continue;
    const rationale = sanitizeSuggestion(item.rationale ?? '');
    const gapTag = typeof item.gap_id === 'number'
      ? ` _(closes gap [${item.gap_id}])_`
      : item.gap_description
        ? ` _(${sanitizeSuggestion(item.gap_description)})_`
        : '';
    lines.push(rationale
      ? `- ${query} — ${rationale}${gapTag}`
      : `- ${query}${gapTag}`,
    );
  }

  return lines.length === 2 ? '' : lines.join('\n');
}

export function appendSignalsAndFollowUps(
  markdown: string,
  signalsSection: string,
  refineQueries: RefineQuerySuggestion[] | undefined,
  options: { includeSignals?: boolean } = {},
): string {
  const includeSignals = options.includeSignals ?? false;
  const sections = [markdown];
  if (includeSignals && signalsSection) {
    sections.push('', '---', signalsSection);
  }
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
  verbose: boolean = false,
): string {
  const rankedUrls = aggregation.rankedUrls;

  // Build tier → entries mapping (keep url data alongside classifier metadata)
  const entryByRank = new Map(classification.results.map((r) => [r.rank, r]));

  const tiers = {
    high: [] as typeof rankedUrls,
    maybe: [] as typeof rankedUrls,
    other: [] as typeof rankedUrls,
  };

  for (const url of rankedUrls) {
    const entry = entryByRank.get(url.rank);
    const tier = entry?.tier;
    if (tier === 'HIGHLY_RELEVANT') {
      tiers.high.push(url);
    } else if (tier === 'MAYBE_RELEVANT') {
      tiers.maybe.push(url);
    } else {
      tiers.other.push(url);
    }
  }

  const lines: string[] = [];

  // Header with generated title, synthesis, and confidence
  lines.push(`## ${classification.title}`);
  lines.push(`> Looking for: ${extract}`);
  lines.push(`> ${totalQueries} queries → ${rankedUrls.length} URLs → ${tiers.high.length} highly relevant, ${tiers.maybe.length} possibly relevant`);
  if (classification.confidence) {
    const confReason = classification.confidence_reason ? ` — ${classification.confidence_reason}` : '';
    lines.push(`> Confidence: \`${classification.confidence}\`${confReason}`);
  }
  lines.push('');
  lines.push(`**Summary:** ${classification.synthesis}`);
  lines.push('');

  // Helper: render one row with optional source_type + reason
  const renderRichRow = (url: typeof rankedUrls[number]): string => {
    const entry = entryByRank.get(url.rank);
    const coveragePct = Math.round(url.coverageRatio * 100);
    const seenIn = `${url.frequency}/${totalQueries} (${coveragePct}%)`;
    const sourceType = entry?.source_type ? `\`${entry.source_type}\`` : '—';
    const reason = entry?.reason ? entry.reason.replace(/\|/g, '\\|') : '—';
    return `| ${url.rank} | [${url.title}](${url.url}) | ${sourceType} | ${seenIn} | ${reason} |`;
  };

  // Highly Relevant tier
  if (tiers.high.length > 0) {
    lines.push(`### Highly Relevant (${tiers.high.length})`);
    lines.push('| # | URL | Source | Seen in | Why |');
    lines.push('|---|-----|--------|---------|-----|');
    for (const url of tiers.high) lines.push(renderRichRow(url));
    lines.push('');
  }

  // Maybe Relevant tier
  if (tiers.maybe.length > 0) {
    lines.push(`### Maybe Relevant (${tiers.maybe.length})`);
    lines.push('| # | URL | Source | Seen in | Why |');
    lines.push('|---|-----|--------|---------|-----|');
    for (const url of tiers.maybe) lines.push(renderRichRow(url));
    lines.push('');
  }

  // Other tier — with query attribution
  if (tiers.other.length > 0) {
    lines.push(`### Other Results (${tiers.other.length})`);
    lines.push('| # | URL | Source | Score | Queries |');
    lines.push('|---|-----|--------|-------|---------|');
    for (const url of tiers.other) {
      const entry = entryByRank.get(url.rank);
      const queryList = url.queries.map((q) => `"${q}"`).join(', ');
      const sourceType = entry?.source_type ? `\`${entry.source_type}\`` : '—';
      let domain: string;
      try {
        domain = new URL(url.url).hostname.replace(/^www\./, '');
      } catch {
        domain = url.url;
      }
      lines.push(`| ${url.rank} | ${domain} | ${sourceType} | ${url.score.toFixed(1)} | ${queryList} |`);
    }
    lines.push('');
  }

  // Signals block is gated behind verbose — it duplicates info already
  // present in the per-row metadata for callers who care.
  // See: docs/code-review/context/05-output-formatting-patterns.md.
  if (verbose) {
    lines.push(buildSignalsSection(aggregation, searches, totalQueries));
  }

  // Gaps section — what the current results don't answer
  if (classification.gaps && classification.gaps.length > 0) {
    lines.push('');
    lines.push('## Gaps');
    for (const gap of classification.gaps) {
      lines.push(`- **[${gap.id}]** ${gap.description}`);
    }
  }

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
        buildRawOutput(params.queries, aggregation, response.searches, params.verbose),
        buildSignalsSection(aggregation, response.searches, response.totalQueries),
        rawRefineQueries,
        { includeSignals: params.verbose },
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
        params.queries,
      );

      if (classification.result) {
        markdown = buildClassifiedOutput(
          classification.result, aggregation, params.extract, response.searches, response.totalQueries, params.verbose,
        );
        llmClassified = true;
        await reporter.progress(85, 100, 'Formatted classified results');
      } else {
        // Classification failed — fall back to raw
        llmError = classification.error ?? 'Unknown classification error';
        mcpLog('warning', `Classification failed, falling back to raw: ${llmError}`, 'search');
        markdown = appendSignalsAndFollowUps(
          buildRawOutput(params.queries, aggregation, response.searches, params.verbose),
          buildSignalsSection(aggregation, response.searches, response.totalQueries),
          undefined,
          { includeSignals: params.verbose },
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
        'Fan out many Google searches in parallel (no hard cap), aggregate and deduplicate results, then classify each URL against your extract goal. Returns a tiered Markdown report: HIGHLY_RELEVANT / MAYBE_RELEVANT / OTHER with source_type and a per-result reason; plus a grounded synthesis with rank citations, a domain-independence confidence, a `## Gaps` list of what the current results do not answer, and `## Suggested follow-up searches` tied to gap ids (non-paraphrases of your prior queries). Think of `queries` as concept groups — diverse facets, not paraphrases. Set `raw=true` to skip classification and get an unclassified ranked list.',
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
