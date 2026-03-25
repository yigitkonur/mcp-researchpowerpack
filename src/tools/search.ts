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
  // Build lookup from ALL ranked URLs so per-query entries can show consensus info
  const urlLookup = buildUrlLookup(aggregation.rankedUrls);
  const consensusUrls = aggregation.rankedUrls.filter(u => u.isConsensus);
  return { aggregation, urlLookup, consensusUrls };
}

function buildConsensusSection(
  keywords: string[],
  aggregation: SearchAggregation,
): string {
  // Always show all ranked URLs (consensus-marked within)
  return generateEnhancedOutput(
    aggregation.rankedUrls, keywords, aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold, aggregation.thresholdNote,
  ) + '\n---\n\n';
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
    entry += result.date
      ? `   - *${result.date}* — ${result.snippet}\n`
      : `   - ${result.snippet}\n`;
  }

  entry += '\n';
  return entry;
}

function buildPerQuerySection(
  response: SearchResponse,
  urlLookup: ReturnType<typeof buildUrlLookup>,
): { markdown: string; totalResults: number } {
  let markdown = `## 📊 Full Search Results by Query\n\n`;

  let totalResults = 0;

  response.searches.forEach((search, index) => {
    markdown += `### Query ${index + 1}: "${search.keyword}"\n\n`;

    search.results.forEach((result, resultIndex) => {
      markdown += formatSearchResultEntry(result, resultIndex + 1, urlLookup);
      totalResults++;
    });

    if (search.related && search.related.length > 0) {
      const relatedSuggestions = search.related
        .map((r: string) => `\`${r}\``)
        .join(', ');
      markdown += `*Related:* ${relatedSuggestions}\n\n`;
    }

    if (index < response.searches.length - 1) markdown += `---\n\n`;
  });

  return { markdown, totalResults };
}

function formatSearchOutput(
  consensusSection: string,
  perQuerySection: string,
  totalResults: number,
  aggregation: SearchAggregation,
  consensusUrlCount: number,
  executionTime: number,
  totalKeywords: number,
): ToolExecutionResult<WebSearchOutput> {
  let markdown = consensusSection + perQuerySection;

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

    const consensusSection = buildConsensusSection(params.keywords, aggregation);
    const { markdown: perQuerySection, totalResults } = buildPerQuerySection(response, urlLookup);
    await reporter.progress(80, 100, 'Ranking and formatting search results');

    const executionTime = Date.now() - startTime;
    mcpLog('info', `Search completed: ${totalResults} results, ${aggregation.totalUniqueUrls} unique URLs, ${consensusUrls.length} consensus`, 'search');
    await reporter.log(
      'info',
      `Search completed with ${totalResults} ranked results and ${consensusUrls.length} consensus URL(s)`,
    );

    return formatSearchOutput(
      consensusSection, perQuerySection, totalResults,
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
        'Run parallel Google searches across 1-100 keywords and return ranked URLs for follow-up scraping.',
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
