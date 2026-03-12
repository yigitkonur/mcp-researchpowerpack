/**
 * Web Scraper Client
 * Generic interface for URL scraping with automatic fallback modes
 * Implements robust error handling that NEVER crashes
 */

import { parseEnv, SCRAPER } from '../config/index.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { calculateBackoff } from '../utils/retry.js';
import { pMapSettled } from '../utils/concurrency.js';
import { mcpLog } from '../utils/logger.js';

// ── Constants ──

const SCRAPE_MODES = ['basic', 'javascript', 'javascript_geo'] as const;
type ScrapeMode = typeof SCRAPE_MODES[number];

const CREDIT_COSTS: Record<string, number> = { basic: 1, javascript: 5, javascript_geo: 5 } as const;
const DEFAULT_SCRAPE_CONCURRENCY = 10 as const;
const SCRAPE_BATCH_SIZE = 30 as const;
const MAX_RETRIES = 3 as const;

// ── Interfaces ──

interface ScrapeRequest {
  readonly url: string;
  readonly mode?: 'basic' | 'javascript';
  readonly timeout?: number;
  readonly country?: string;
}

interface ScrapeResponse {
  readonly content: string;
  readonly statusCode: number;
  readonly credits: number;
  readonly headers?: Record<string, string>;
  readonly error?: StructuredError;
}

interface BatchScrapeResult {
  readonly results: ReadonlyArray<ScrapeResponse & { readonly url: string }>;
  readonly batchesProcessed: number;
  readonly totalAttempted: number;
  readonly rateLimitHits: number;
}

// Status codes that indicate we should retry (no credit consumed)
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504, 510]);
// Status codes that are permanent failures (don't retry)
const PERMANENT_FAILURE_CODES = new Set([400, 401, 403]);

/** Fallback attempt descriptor used by scrapeWithFallback */
interface FallbackAttempt {
  readonly mode: 'basic' | 'javascript';
  readonly country?: string;
  readonly description: string;
}

const FALLBACK_ATTEMPTS: readonly FallbackAttempt[] = [
  { mode: 'basic', description: 'basic mode' },
  { mode: 'javascript', description: 'javascript rendering' },
  { mode: 'javascript', country: 'us', description: 'javascript + US geo-targeting' },
] as const;

export class ScraperClient {
  private apiKey: string;
  private baseURL = 'https://api.scrape.do';

  constructor(apiKey?: string) {
    const env = parseEnv();
    this.apiKey = apiKey || env.SCRAPER_API_KEY;

    if (!this.apiKey) {
      throw new Error('SCRAPEDO_API_KEY is required');
    }
  }

  /**
   * Scrape a single URL with retry logic
   * NEVER throws - always returns a ScrapeResponse (possibly with error)
   */
  async scrape(request: ScrapeRequest, maxRetries = MAX_RETRIES): Promise<ScrapeResponse> {
    const { url, mode = 'basic', timeout = 30, country } = request;
    const credits = CREDIT_COSTS[mode] ?? 1;

    // Validate URL first
    try {
      new URL(url);
    } catch {
      return {
        content: `Invalid URL: ${url}`,
        statusCode: 400,
        credits: 0,
        error: { code: ErrorCode.INVALID_INPUT, message: `Invalid URL: ${url}`, retryable: false },
      };
    }

    const params = new URLSearchParams({
      url: url,
      token: this.apiKey,
      timeout: String(timeout * 1000),
    });

    if (mode === 'javascript') {
      params.append('render', 'true');
    }

    if (country) {
      params.append('geoCode', country.toUpperCase());
    }

    const apiUrl = `${this.baseURL}?${params.toString()}`;
    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Use AbortController for timeout
        const timeoutMs = (timeout + 10) * 1000; // Add 10s buffer over scrape timeout
        const response = await fetchWithTimeout(apiUrl, {
          method: 'GET',
          headers: { Accept: 'text/html,application/json' },
          timeoutMs,
        });

        // Safely read response body
        let content: string;
        try {
          content = await response.text();
        } catch (readError) {
          content = `Failed to read response: ${readError instanceof Error ? readError.message : String(readError)}`;
        }

        // SUCCESS: 2xx - Successful API call
        if (response.ok) {
          return {
            content,
            statusCode: response.status,
            credits,
            headers: Object.fromEntries(response.headers.entries()),
          };
        }

        // 404 - Target not found (permanent, but not an error for our purposes)
        if (response.status === 404) {
          return {
            content: '404 - Page not found',
            statusCode: 404,
            credits,
          };
        }

        // Permanent failures - don't retry
        if (PERMANENT_FAILURE_CODES.has(response.status)) {
          const errorMsg = response.status === 401
            ? 'No credits remaining or subscription suspended'
            : `Request failed with status ${response.status}`;
          return {
            content: `Error: ${errorMsg}`,
            statusCode: response.status,
            credits: 0,
            error: {
              code: response.status === 401 ? ErrorCode.AUTH_ERROR : ErrorCode.INVALID_INPUT,
              message: errorMsg,
              retryable: false,
              statusCode: response.status,
            },
          };
        }

        // Retryable status codes
        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          lastError = {
            code: response.status === 429 ? ErrorCode.RATE_LIMITED : ErrorCode.SERVICE_UNAVAILABLE,
            message: `Server returned ${response.status}`,
            retryable: true,
            statusCode: response.status,
          };

          if (attempt < maxRetries - 1) {
            const delayMs = calculateBackoff(attempt);
            mcpLog('warning', `${response.status} on attempt ${attempt + 1}/${maxRetries}. Retrying in ${delayMs}ms`, 'scraper');
            await sleep(delayMs);
            continue;
          }
        }

        // Other non-success status - treat as retryable
        lastError = classifyError({ status: response.status, message: content });
        if (attempt < maxRetries - 1 && lastError.retryable) {
          const delayMs = calculateBackoff(attempt);
          mcpLog('warning', `Status ${response.status}. Retrying in ${delayMs}ms`, 'scraper');
          await sleep(delayMs);
          continue;
        }

        // Final attempt failed
        return {
          content: `Error: ${lastError.message}`,
          statusCode: response.status,
          credits: 0,
          error: lastError,
        };

      } catch (error) {
        lastError = classifyError(error);

        // Non-retryable errors - return immediately
        if (!lastError.retryable) {
          return {
            content: `Error: ${lastError.message}`,
            statusCode: lastError.statusCode || 500,
            credits: 0,
            error: lastError,
          };
        }

        // Retryable error - continue if attempts remaining
        if (attempt < maxRetries - 1) {
          const delayMs = calculateBackoff(attempt);
          mcpLog('warning', `${lastError.code}: ${lastError.message}. Retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`, 'scraper');
          await sleep(delayMs);
          continue;
        }
      }
    }

    // All retries exhausted
    return {
      content: `Error: Failed after ${maxRetries} attempts. ${lastError?.message || 'Unknown error'}`,
      statusCode: lastError?.statusCode || 500,
      credits: 0,
      error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'All retries exhausted', retryable: false },
    };
  }

  /**
   * Scrape with automatic fallback through different modes
   * NEVER throws - always returns a ScrapeResponse
   */
  async scrapeWithFallback(url: string, options: { timeout?: number } = {}): Promise<ScrapeResponse> {
    const attemptResults: string[] = [];
    let lastResult: ScrapeResponse | null = null;

    for (const attempt of FALLBACK_ATTEMPTS) {
      const result = await this.tryFallbackAttempt(url, attempt, options);

      if (result.done) {
        if (attemptResults.length > 0) {
          mcpLog('info', `Success with ${attempt.description} after ${attemptResults.length} fallback(s)`, 'scraper');
        }
        return result.response;
      }

      lastResult = result.response;
      attemptResults.push(`${attempt.description}: ${result.response.error?.message || result.response.statusCode}`);
      mcpLog('warning', `Failed with ${attempt.description} (${result.response.statusCode}), trying next fallback...`, 'scraper');
    }

    // All fallbacks exhausted
    const errorMessage = `Failed after ${FALLBACK_ATTEMPTS.length} fallback modes: ${attemptResults.join('; ')}`;
    return {
      content: `Error: ${errorMessage}`,
      statusCode: lastResult?.statusCode || 500,
      credits: 0,
      error: {
        code: ErrorCode.SERVICE_UNAVAILABLE,
        message: errorMessage,
        retryable: false,
      },
    };
  }

  /**
   * Execute a single fallback attempt and determine whether to continue.
   * Returns { done: true } on success/terminal or { done: false } to try the next mode.
   */
  private async tryFallbackAttempt(
    url: string,
    attempt: FallbackAttempt,
    options: { timeout?: number },
  ): Promise<{ done: boolean; response: ScrapeResponse }> {
    const result = await this.scrape({
      url,
      mode: attempt.mode,
      timeout: options.timeout,
      country: attempt.country,
    });

    // Success
    if (result.statusCode >= 200 && result.statusCode < 300 && !result.error) {
      return { done: true, response: result };
    }

    // 404 is a valid response, not an error
    if (result.statusCode === 404) {
      return { done: true, response: result };
    }

    // Non-retryable errors - don't try other modes
    if (result.error && !result.error.retryable) {
      mcpLog('error', `Non-retryable error with ${attempt.description}: ${result.error.message}`, 'scraper');
      return { done: true, response: result };
    }

    return { done: false, response: result };
  }

  /**
   * Scrape multiple URLs with batching
   * NEVER throws - always returns results array
   */
  async scrapeMultiple(urls: string[], options: { timeout?: number } = {}): Promise<Array<ScrapeResponse & { url: string }>> {
    if (urls.length === 0) {
      return [];
    }

    if (urls.length <= SCRAPE_BATCH_SIZE) {
      return this.processBatch(urls, options);
    }

    const result = await this.batchScrape(urls, options);
    return result.results as Array<ScrapeResponse & { url: string }>;
  }

  /**
   * Batch scrape with progress callback
   * NEVER throws - uses Promise.allSettled internally
   */
  async batchScrape(
    urls: string[],
    options: { timeout?: number } = {},
    onBatchComplete?: (batchNum: number, totalBatches: number, processed: number) => void
  ): Promise<BatchScrapeResult> {
    const totalBatches = Math.ceil(urls.length / SCRAPE_BATCH_SIZE);
    const allResults: Array<ScrapeResponse & { url: string }> = [];
    let rateLimitHits = 0;

    mcpLog('info', `Starting batch processing: ${urls.length} URLs in ${totalBatches} batch(es)`, 'scraper');

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const startIdx = batchNum * SCRAPE_BATCH_SIZE;
      const endIdx = Math.min(startIdx + SCRAPE_BATCH_SIZE, urls.length);
      const batchUrls = urls.slice(startIdx, endIdx);

      mcpLog('info', `Processing batch ${batchNum + 1}/${totalBatches} (${batchUrls.length} URLs)`, 'scraper');

      const batchResults = await pMapSettled(
        batchUrls,
        url => this.scrapeWithFallback(url, options),
        DEFAULT_SCRAPE_CONCURRENCY
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        if (!result) continue;
        const url = batchUrls[i] ?? '';

        if (result.status === 'fulfilled') {
          const scrapeResult = result.value;
          allResults.push({ ...scrapeResult, url });

          // Track rate limits
          if (scrapeResult.error?.code === ErrorCode.RATE_LIMITED) {
            rateLimitHits++;
          }
        } else {
          // This shouldn't happen since scrapeWithFallback never throws,
          // but handle it gracefully just in case
          const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          mcpLog('error', `Unexpected rejection for ${url}: ${errorMsg}`, 'scraper');

          allResults.push({
            url,
            content: `Error: Unexpected failure - ${errorMsg}`,
            statusCode: 500,
            credits: 0,
            error: classifyError(result.reason),
          });
        }
      }

      // Safe callback invocation
      try {
        onBatchComplete?.(batchNum + 1, totalBatches, allResults.length);
      } catch (callbackError) {
        mcpLog('error', `onBatchComplete callback error: ${callbackError}`, 'scraper');
      }

      mcpLog('info', `Completed batch ${batchNum + 1}/${totalBatches} (${allResults.length}/${urls.length} total)`, 'scraper');

      // Adaptive delay between batches — back off harder under rate limiting
      if (batchNum < totalBatches - 1) {
        const batchDelay = rateLimitHits > 0 ? 2000 : 500;
        await sleep(batchDelay);
      }
    }

    return { results: allResults, batchesProcessed: totalBatches, totalAttempted: urls.length, rateLimitHits };
  }

  /**
   * Process a single batch of URLs
   * NEVER throws
   */
  private async processBatch(urls: string[], options: { timeout?: number }): Promise<Array<ScrapeResponse & { url: string }>> {
    const results = await pMapSettled(urls, url => this.scrapeWithFallback(url, options), DEFAULT_SCRAPE_CONCURRENCY);

    return results.map((result, index) => {
      const url = urls[index] || '';

      if (result.status === 'fulfilled') {
        return { ...result.value, url };
      }

      // Shouldn't happen, but handle gracefully
      return {
        url,
        content: `Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        statusCode: 500,
        credits: 0,
        error: classifyError(result.reason),
      };
    });
  }
}
