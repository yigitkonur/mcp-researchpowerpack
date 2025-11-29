/**
 * Web Search Tool Handler
 */

import type { WebSearchParams, WebSearchOutput } from '../schemas/web-search.js';
import { SearchClient } from '../clients/search.js';
import {
  aggregateAndRank,
  buildUrlLookup,
  lookupUrl,
  generateEnhancedOutput,
  markConsensus,
} from '../utils/url-aggregator.js';
import { CTR_WEIGHTS } from '../config/index.js';

interface ToolOptions {
  sessionId?: string;
  logger?: (level: 'info' | 'error' | 'debug', message: string, sessionId: string) => Promise<void>;
}

function getPositionScore(position: number): number {
  if (position >= 1 && position <= 10) {
    return CTR_WEIGHTS[position] ?? 0;
  }
  return Math.max(0, 10 - (position - 10) * 0.5);
}

export async function handleWebSearch(
  params: WebSearchParams,
  options: ToolOptions = {}
): Promise<{ content: string; structuredContent: WebSearchOutput }> {
  const { sessionId, logger } = options;
  const startTime = Date.now();

  try {
    if (sessionId && logger) {
      await logger('info', `Searching for ${params.keywords.length} keyword(s)`, sessionId);
    }

    const client = new SearchClient();
    const response = await client.searchMultiple(params.keywords);

    const aggregation = aggregateAndRank(response.searches, 5);
    const urlLookup = buildUrlLookup(aggregation.rankedUrls);

    const consensusUrls = aggregation.rankedUrls.filter(
      url => url.frequency >= aggregation.frequencyThreshold
    );

    let markdown = '';

    if (consensusUrls.length > 0) {
      markdown += generateEnhancedOutput(
        consensusUrls,
        params.keywords,
        aggregation.totalUniqueUrls,
        aggregation.frequencyThreshold,
        aggregation.thresholdNote
      );
      markdown += '\n---\n\n';
    } else {
      markdown += `## The Perfect Search Results (Aggregated from ${response.totalKeywords} Queries)\n\n`;
      markdown += `> *No high-consensus URLs found across searches. Results may be highly diverse.*\n\n`;
      markdown += `---\n\n`;
    }

    // Limit output based on number of queries to keep under ~20k tokens
    const MAX_QUERIES_SHOWN = 15;
    const MAX_RESULTS_PER_QUERY = response.totalKeywords > 10 ? 5 : 10;
    const queriesToShow = response.searches.slice(0, MAX_QUERIES_SHOWN);
    const queriesOmitted = response.searches.length - queriesToShow.length;

    markdown += `## 📊 Full Search Results by Query`;
    if (queriesOmitted > 0) {
      markdown += ` (showing ${queriesToShow.length} of ${response.searches.length})`;
    }
    markdown += `\n\n`;

    let totalResults = 0;

    queriesToShow.forEach((search, index) => {
      markdown += `### Query ${index + 1}: "${search.keyword}"\n\n`;

      search.results.slice(0, MAX_RESULTS_PER_QUERY).forEach((result, resultIndex) => {
        const position = resultIndex + 1;
        const positionScore = getPositionScore(position);

        const rankedUrl = lookupUrl(result.link, urlLookup);
        const frequency = rankedUrl?.frequency ?? 1;
        const consensusMark = markConsensus(frequency);
        const consensusInfo = rankedUrl
          ? `${consensusMark} (${frequency} searches)`
          : `${consensusMark} (1 search)`;

        markdown += `${position}. **[${result.title}](${result.link})** — Position ${position} | Score: ${positionScore.toFixed(1)} | Consensus: ${consensusInfo}\n`;

        if (result.snippet) {
          let snippet = result.snippet;
          if (snippet.length > 150) {
            snippet = snippet.substring(0, 147) + '...';
          }

          if (result.date) {
            markdown += `   - *${result.date}* — ${snippet}\n`;
          } else {
            markdown += `   - ${snippet}\n`;
          }
        }

        markdown += '\n';
        totalResults++;
      });

      if (search.related && search.related.length > 0) {
        const relatedSuggestions = search.related
          .slice(0, 5)
          .map((r: string) => `\`${r}\``)
          .join(', ');

        markdown += `*Related:* ${relatedSuggestions}\n\n`;
      }

      if (index < queriesToShow.length - 1) {
        markdown += `---\n\n`;
      }
    });

    if (queriesOmitted > 0) {
      markdown += `\n---\n\n> *${queriesOmitted} additional queries not shown. Consensus URLs above include all ${response.searches.length} queries.*\n`;
    }

    const executionTime = Date.now() - startTime;

    if (sessionId && logger) {
      await logger(
        'info',
        `Search completed: ${totalResults} results, ${aggregation.totalUniqueUrls} unique URLs, ${consensusUrls.length} consensus URLs in ${executionTime}ms`,
        sessionId
      );
    }

    const metadata = {
      total_keywords: response.totalKeywords,
      total_results: totalResults,
      execution_time_ms: executionTime,
      total_unique_urls: aggregation.totalUniqueUrls,
      consensus_url_count: consensusUrls.length,
      frequency_threshold: aggregation.frequencyThreshold,
    };

    return { content: markdown, structuredContent: { content: markdown, metadata } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (sessionId && logger) {
      await logger('error', errorMessage, sessionId);
    }

    const executionTime = Date.now() - startTime;
    const errorContent = `# ❌ Search Failed\n\n${errorMessage}\n\n**Tip:** Make sure SERPER_API_KEY is set in your environment variables.`;

    return {
      content: errorContent,
      structuredContent: {
        content: errorContent,
        metadata: {
          total_keywords: params.keywords.length,
          total_results: 0,
          execution_time_ms: executionTime,
        },
      },
    };
  }
}
