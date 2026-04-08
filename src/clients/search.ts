/**
 * Web Search Client
 * Generic interface for web search via Google (Serper implementation)
 * Implements robust error handling that NEVER crashes
 */

import { parseEnv, CONCURRENCY } from '../config/index.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { calculateBackoff } from '../utils/retry.js';
import { pMap } from '../utils/concurrency.js';
import { mcpLog } from '../utils/logger.js';

// ── Constants ──

const SERPER_API_URL = 'https://google.serper.dev/search' as const;
const DEFAULT_RESULTS_PER_KEYWORD = 10 as const;
const MAX_RETRIES = 3 as const;

// ── Data Interfaces ──

interface SearchResult {
  readonly title: string;
  readonly link: string;
  readonly snippet: string;
  readonly date?: string;
  readonly position: number;
}

export interface KeywordSearchResult {
  readonly keyword: string;
  readonly results: SearchResult[];
  readonly totalResults: number;
  readonly related: string[];
  readonly error?: StructuredError;
}

interface MultipleSearchResponse {
  readonly searches: KeywordSearchResult[];
  readonly totalKeywords: number;
  readonly executionTime: number;
  readonly error?: StructuredError;
}

export interface RedditSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly date?: string;
}

// ── Retry Configuration ──

const SEARCH_RETRY_CONFIG = {
  maxRetries: MAX_RETRIES,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 30000,
} as const;

const RETRYABLE_SEARCH_CODES = new Set([429, 500, 502, 503, 504]);

// Pre-compiled regex patterns for Reddit search
const REDDIT_SITE_REGEX = /site:\s*reddit\.com/i;
const REDDIT_SUBREDDIT_SUFFIX_REGEX = / : r\/\w+$/;
const REDDIT_SUFFIX_REGEX = / - Reddit$/;

// ── Helper: Parse Serper search responses into structured results ──

function parseSearchResponses(
  responses: Array<Record<string, unknown>>,
  keywords: string[],
): KeywordSearchResult[] {
  return responses.map((resp, index) => {
    try {
      const organic = (resp.organic || []) as Array<Record<string, unknown>>;
      const results: SearchResult[] = organic.map((item, idx) => ({
        title: (item.title as string) || 'No title',
        link: (item.link as string) || '#',
        snippet: (item.snippet as string) || '',
        date: item.date as string | undefined,
        position: (item.position as number) || idx + 1,
      }));

      const searchInfo = resp.searchInformation as Record<string, unknown> | undefined;
      const totalResults = searchInfo?.totalResults
        ? parseInt(String(searchInfo.totalResults).replace(/,/g, ''), 10)
        : results.length;

      const relatedSearches = (resp.relatedSearches || []) as Array<Record<string, unknown>>;
      const related = relatedSearches.map((r) => (r.query as string) || '');

      return { keyword: keywords[index] || '', results, totalResults, related };
    } catch {
      return { keyword: keywords[index] || '', results: [], totalResults: 0, related: [] };
    }
  });
}

// ── Helper: Execute search API call with retry ──

async function executeSearchWithRetry(
  apiKey: string,
  body: unknown,
  isRetryable: (status?: number, error?: unknown) => boolean,
): Promise<{ data: unknown; error?: StructuredError }> {
  let lastError: StructuredError | undefined;

  for (let attempt = 0; attempt <= SEARCH_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        mcpLog('warning', `Retry attempt ${attempt}/${SEARCH_RETRY_CONFIG.maxRetries}`, 'search');
      }

      const response = await fetchWithTimeout(SERPER_API_URL, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: SEARCH_RETRY_CONFIG.timeoutMs,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        lastError = classifyError({ status: response.status, message: errorText });

        if (isRetryable(response.status) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
          const delayMs = calculateBackoff(attempt, SEARCH_RETRY_CONFIG.baseDelayMs, SEARCH_RETRY_CONFIG.maxDelayMs);
          mcpLog('warning', `API returned ${response.status}, retrying in ${delayMs}ms...`, 'search');
          await sleep(delayMs);
          continue;
        }

        return { data: undefined, error: lastError };
      }

      try {
        const data = await response.json();
        return { data };
      } catch {
        return {
          data: undefined,
          error: { code: ErrorCode.PARSE_ERROR, message: 'Failed to parse search response', retryable: false },
        };
      }
    } catch (error) {
      lastError = classifyError(error);

      if (isRetryable(undefined, error) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
        const delayMs = calculateBackoff(attempt, SEARCH_RETRY_CONFIG.baseDelayMs, SEARCH_RETRY_CONFIG.maxDelayMs);
        mcpLog('warning', `${lastError.code}: ${lastError.message}, retrying in ${delayMs}ms...`, 'search');
        await sleep(delayMs);
        continue;
      }

      return { data: undefined, error: lastError };
    }
  }

  return {
    data: undefined,
    error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'Search failed', retryable: false },
  };
}

// ── SearchClient ──

export class SearchClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    const env = parseEnv();
    this.apiKey = apiKey || env.SEARCH_API_KEY || '';

    if (!this.apiKey) {
      throw new Error('Web search capability is not configured. Please set up the required API credentials.');
    }
  }

  /**
   * Check if error is retryable
   */
  private isRetryable(status?: number, error?: unknown): boolean {
    if (status && RETRYABLE_SEARCH_CODES.has(status)) return true;

    if (error == null) return false;
    const message = (typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
      ? (error as { message: string }).message.toLowerCase()
      : '';
    return message.includes('timeout') || message.includes('rate limit') || message.includes('connection');
  }

  /**
   * Search multiple keywords in parallel
   * NEVER throws - always returns a valid response
   */
  async searchMultiple(keywords: string[]): Promise<MultipleSearchResponse> {
    const startTime = Date.now();

    if (keywords.length === 0) {
      return {
        searches: [],
        totalKeywords: 0,
        executionTime: 0,
        error: { code: ErrorCode.INVALID_INPUT, message: 'No keywords provided', retryable: false },
      };
    }

    const searchQueries = keywords.map(keyword => ({ q: keyword }));
    const { data, error } = await executeSearchWithRetry(
      this.apiKey,
      searchQueries,
      (status, err) => this.isRetryable(status, err),
    );

    if (error || data === undefined) {
      return {
        searches: [],
        totalKeywords: keywords.length,
        executionTime: Date.now() - startTime,
        error,
      };
    }

    const responses = Array.isArray(data) ? data : [data];
    const searches = parseSearchResponses(responses as Array<Record<string, unknown>>, keywords);

    return { searches, totalKeywords: keywords.length, executionTime: Date.now() - startTime };
  }

  /**
   * Search Reddit via Google (adds site:reddit.com automatically)
   * NEVER throws - returns empty array on failure
   */
  async searchReddit(query: string, dateAfter?: string): Promise<RedditSearchResult[]> {
    if (!query?.trim()) {
      return [];
    }

    let q = query.replace(REDDIT_SITE_REGEX, '').trim() + ' site:reddit.com';

    if (dateAfter) {
      q += ` after:${dateAfter}`;
    }

    for (let attempt = 0; attempt <= SEARCH_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(SERPER_API_URL, {
          method: 'POST',
          headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, num: DEFAULT_RESULTS_PER_KEYWORD }),
          timeoutMs: SEARCH_RETRY_CONFIG.timeoutMs,
        });

        if (!res.ok) {
          if (this.isRetryable(res.status) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
            const delayMs = calculateBackoff(attempt, SEARCH_RETRY_CONFIG.baseDelayMs, SEARCH_RETRY_CONFIG.maxDelayMs);
            mcpLog('warning', `Reddit search ${res.status}, retrying in ${delayMs}ms...`, 'search');
            await sleep(delayMs);
            continue;
          }
          mcpLog('error', `Reddit search failed with status ${res.status}`, 'search');
          return [];
        }

        const data = await res.json() as { organic?: Array<{ title: string; link: string; snippet: string; date?: string }> };
        return (data.organic || []).map((r) => ({
          title: (r.title || '').replace(REDDIT_SUBREDDIT_SUFFIX_REGEX, '').replace(REDDIT_SUFFIX_REGEX, ''),
          url: r.link || '',
          snippet: r.snippet || '',
          date: r.date,
        }));

      } catch (error) {
        const err = classifyError(error);
        if (this.isRetryable(undefined, error) && attempt < SEARCH_RETRY_CONFIG.maxRetries) {
          const delayMs = calculateBackoff(attempt, SEARCH_RETRY_CONFIG.baseDelayMs, SEARCH_RETRY_CONFIG.maxDelayMs);
          mcpLog('warning', `Reddit search ${err.code}, retrying in ${delayMs}ms...`, 'search');
          await sleep(delayMs);
          continue;
        }
        mcpLog('error', `Reddit search failed: ${err.message}`, 'search');
        return [];
      }
    }

    return [];
  }

  /**
   * Search Reddit with multiple queries (bounded concurrency)
   * NEVER throws - searchReddit never throws, pMap preserves order
   */
  async searchRedditMultiple(queries: string[], dateAfter?: string): Promise<Map<string, RedditSearchResult[]>> {
    if (queries.length === 0) {
      return new Map();
    }

    const results = await pMap(
      queries,
      q => this.searchReddit(q, dateAfter),
      CONCURRENCY.SEARCH
    );

    return new Map(queries.map((q, i) => [q, results[i] || []]));
  }
}
