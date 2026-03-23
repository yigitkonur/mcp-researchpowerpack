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
  buildUrlLookup,
  lookupUrl,
  generateEnhancedOutput,
  markConsensus,
} from '../utils/url-aggregator.js';
import { CTR_WEIGHTS } from '../config/index.js';
import { classifyError } from '../utils/errors.js';
import {
  mcpLog,
  formatSuccess,
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

function getPositionScore(position: number): number {
  if (position >= 1 && position <= 10) {
    return CTR_WEIGHTS[position] ?? 0;
  }
  return Math.max(0, 10 - (position - 10) * 0.5);
}

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

function processAndRankResults(response: SearchResponse): {
  aggregation: SearchAggregation;
  urlLookup: ReturnType<typeof buildUrlLookup>;
  consensusUrls: SearchAggregation['rankedUrls'];
} {
  const aggregation = aggregateAndRank(response.searches, 5);
  const urlLookup = buildUrlLookup(aggregation.rankedUrls);
  const consensusUrls = aggregation.rankedUrls.filter(
    url => url.frequency >= aggregation.frequencyThreshold,
  );
  return { aggregation, urlLookup, consensusUrls };
}

function buildConsensusSection(
  consensusUrls: SearchAggregation['rankedUrls'],
  keywords: string[],
  aggregation: SearchAggregation,
): string {
  if (consensusUrls.length > 0) {
    return generateEnhancedOutput(
      consensusUrls, keywords, aggregation.totalUniqueUrls,
      aggregation.frequencyThreshold, aggregation.thresholdNote,
    ) + '\n---\n\n';
  }
  return `## The Perfect Search Results (Aggregated from ${keywords.length} Queries)\n\n` +
    `> *No high-consensus URLs found across searches. Results may be highly diverse.*\n\n---\n\n`;
}

function formatSearchResultEntry(
  result: { title: string; link: string; snippet?: string; date?: string },
  position: number,
  urlLookup: ReturnType<typeof buildUrlLookup>,
): string {
  const positionScore = getPositionScore(position);
  const rankedUrl = lookupUrl(result.link, urlLookup);
  const frequency = rankedUrl?.frequency ?? 1;
  const consensusMark = markConsensus(frequency);
  const consensusInfo = rankedUrl
    ? `${consensusMark} (${frequency} searches)`
    : `${consensusMark} (1 search)`;

  let entry = `${position}. **[${result.title}](${result.link})** — Position ${position} | Score: ${positionScore.toFixed(1)} | Consensus: ${consensusInfo}\n`;

  if (result.snippet) {
    let snippet = result.snippet;
    if (snippet.length > 150) snippet = snippet.substring(0, 147) + '...';
    entry += result.date
      ? `   - *${result.date}* — ${snippet}\n`
      : `   - ${snippet}\n`;
  }

  entry += '\n';
  return entry;
}

function buildPerQuerySection(
  response: SearchResponse,
  urlLookup: ReturnType<typeof buildUrlLookup>,
): { markdown: string; totalResults: number } {
  const MAX_QUERIES_SHOWN = 15;
  const MAX_RESULTS_PER_QUERY = response.totalKeywords > 10 ? 5 : 10;
  const queriesToShow = response.searches.slice(0, MAX_QUERIES_SHOWN);
  const queriesOmitted = response.searches.length - queriesToShow.length;

  let markdown = `## 📊 Full Search Results by Query`;
  if (queriesOmitted > 0) {
    markdown += ` (showing ${queriesToShow.length} of ${response.searches.length})`;
  }
  markdown += `\n\n`;

  let totalResults = 0;

  queriesToShow.forEach((search, index) => {
    markdown += `### Query ${index + 1}: "${search.keyword}"\n\n`;

    search.results.slice(0, MAX_RESULTS_PER_QUERY).forEach((result, resultIndex) => {
      markdown += formatSearchResultEntry(result, resultIndex + 1, urlLookup);
      totalResults++;
    });

    if (search.related && search.related.length > 0) {
      const relatedSuggestions = search.related
        .slice(0, 5)
        .map((r: string) => `\`${r}\``)
        .join(', ');
      markdown += `*Related:* ${relatedSuggestions}\n\n`;
    }

    if (index < queriesToShow.length - 1) markdown += `---\n\n`;
  });

  if (queriesOmitted > 0) {
    markdown += `\n---\n\n> *${queriesOmitted} additional queries not shown. Consensus URLs above include all ${response.searches.length} queries.*\n`;
  }

  return { markdown, totalResults };
}

function buildSearchNextSteps(
  consensusUrls: SearchAggregation['rankedUrls'],
  rankedUrls: SearchAggregation['rankedUrls'],
): string[] {
  const topConsensusUrls = consensusUrls.length > 0
    ? consensusUrls.slice(0, 5).map(u => `"${u.url}"`).join(', ')
    : rankedUrls.slice(0, 5).map(u => `"${u.url}"`).join(', ');

  return [
    `MUST DO: scrape-links(urls=[${topConsensusUrls}], use_llm=true, what_to_extract="Extract key findings | recommendations | data | evidence | comparisons") — searching only gives URLs, scraping gets the actual content`,
    'COMMUNITY CHECK: search-reddit(queries=["topic recommendations", "topic best 2025", "topic vs alternatives"]) — get real user experiences',
    'ITERATE: If results are insufficient, search again with different keywords from "Related" suggestions above',
    'SYNTHESIZE (only after scraping + Reddit): deep-research(questions=[{question: "Based on scraped content and community feedback..."}])',
  ];
}

function formatSearchOutput(
  consensusSection: string,
  perQuerySection: string,
  nextSteps: string[],
  totalResults: number,
  aggregation: SearchAggregation,
  consensusUrlCount: number,
  executionTime: number,
  totalKeywords: number,
): ToolExecutionResult<WebSearchOutput> {
  let markdown = consensusSection + perQuerySection;

  markdown += '\n\n---\n\n**Next Steps (DO ALL — research is a loop, not a single call):**\n';
  nextSteps.forEach((step, i) => { markdown += `${i + 1}. ${step}\n`; });

  markdown += `\n---\n*${formatDuration(executionTime)} | ${aggregation.totalUniqueUrls} unique URLs | ${consensusUrlCount} consensus*`;

  const metadata = {
    total_keywords: totalKeywords,
    total_results: totalResults,
    execution_time_ms: executionTime,
    total_unique_urls: aggregation.totalUniqueUrls,
    consensus_url_count: consensusUrlCount,
    frequency_threshold: aggregation.frequencyThreshold,
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
      'deep-research(questions=[{question: "What are the key findings, best practices, and recommendations for [topic]?"}]) — uses OpenRouter API (different key), not affected by this error',
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

    const { aggregation, urlLookup, consensusUrls } = processAndRankResults(response);
    await reporter.log(
      'info',
      `Collected ${aggregation.totalUniqueUrls} unique URLs across ${response.totalKeywords} queries`,
    );

    const consensusSection = buildConsensusSection(consensusUrls, params.keywords, aggregation);
    const { markdown: perQuerySection, totalResults } = buildPerQuerySection(response, urlLookup);
    await reporter.progress(80, 100, 'Ranking and formatting search results');

    const executionTime = Date.now() - startTime;
    mcpLog('info', `Search completed: ${totalResults} results, ${aggregation.totalUniqueUrls} unique URLs, ${consensusUrls.length} consensus`, 'search');
    await reporter.log(
      'info',
      `Search completed with ${totalResults} ranked results and ${consensusUrls.length} consensus URL(s)`,
    );

    const nextSteps = buildSearchNextSteps(consensusUrls, aggregation.rankedUrls);

    return formatSearchOutput(
      consensusSection, perQuerySection, nextSteps, totalResults,
      aggregation, consensusUrls.length, executionTime, response.totalKeywords,
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
        'Run parallel Google searches across 3-100 keywords and return ranked URLs for follow-up scraping.',
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
