/**
 * Jina Reader Client
 *
 * Converts any URL (including PDFs, DOCX, PPTX, HTML) into clean markdown via
 * the public `https://r.jina.ai/<url>` endpoint. Used by `scrape-links` for
 * document formats that our HTML-assumed pipeline (Scrape.do + Readability +
 * Turndown) cannot decode.
 *
 * NEVER throws — every failure surfaces as a classified `StructuredError`
 * in the returned response, matching the shape of `ScraperClient.scrape`.
 *
 * Auth: optional `JINA_API_KEY` raises the rate limit from 20 RPM to 200+ RPM.
 * Without a key the endpoint still works; we just retry more aggressively on
 * 429 responses.
 */

import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { calculateBackoff } from '../utils/retry.js';
import { mcpLog } from '../utils/logger.js';

// ── Constants ──

const JINA_READER_BASE = 'https://r.jina.ai/' as const;
const DEFAULT_TIMEOUT_MS = 60_000 as const; // Jina can take a while for large PDFs
const MAX_RETRIES = 2 as const;

// ── Interfaces ──

export interface JinaConvertRequest {
  readonly url: string;
  readonly timeoutMs?: number;
}

export interface JinaConvertResponse {
  readonly content: string;
  readonly statusCode: number;
  /** Always 0 — Jina is a separate service from Scrape.do's credit pool. */
  readonly credits: 0;
  readonly usageTokens?: number;
  readonly error?: StructuredError;
}

// ── Client ──

export class JinaClient {
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string) {
    const fromEnv = process.env.JINA_API_KEY?.trim();
    this.apiKey = apiKey?.trim() || fromEnv || undefined;
  }

  /**
   * Convert a URL to markdown via Jina Reader.
   * NEVER throws — always returns a JinaConvertResponse (possibly with error).
   */
  async convert(request: JinaConvertRequest): Promise<JinaConvertResponse> {
    const { url, timeoutMs = DEFAULT_TIMEOUT_MS } = request;

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

    // Jina Reader parses the full target URL as the path suffix. Query strings
    // and fragments in the target are preserved verbatim; no encoding needed.
    const jinaUrl = `${JINA_READER_BASE}${url}`;

    const headers: Record<string, string> = {
      Accept: 'text/markdown',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetchWithTimeout(jinaUrl, {
          method: 'GET',
          headers,
          timeoutMs,
        });

        let content: string;
        try {
          content = await response.text();
        } catch (readError) {
          content = `Failed to read Jina response: ${readError instanceof Error ? readError.message : String(readError)}`;
        }

        const usageHeader = response.headers.get('x-usage-tokens');
        const usageTokens = usageHeader ? Number(usageHeader) : undefined;

        if (response.ok) {
          if (!content.trim()) {
            return {
              content: 'Jina returned an empty body',
              statusCode: response.status,
              credits: 0,
              usageTokens: Number.isFinite(usageTokens) ? usageTokens : undefined,
              error: {
                code: ErrorCode.UNSUPPORTED_BINARY_CONTENT,
                message: 'Jina Reader returned empty content for this URL',
                retryable: false,
              },
            };
          }
          return {
            content,
            statusCode: response.status,
            credits: 0,
            usageTokens: Number.isFinite(usageTokens) ? usageTokens : undefined,
          };
        }

        // 401/403 — auth or quota problems. Not retryable.
        if (response.status === 401 || response.status === 403) {
          return {
            content: `Jina auth/quota error (${response.status}): ${content.slice(0, 200)}`,
            statusCode: response.status,
            credits: 0,
            error: {
              code: response.status === 401 ? ErrorCode.AUTH_ERROR : ErrorCode.QUOTA_EXCEEDED,
              message: response.status === 401
                ? 'Jina Reader auth failed — check JINA_API_KEY'
                : 'Jina Reader quota exceeded',
              retryable: false,
              statusCode: response.status,
            },
          };
        }

        // 404 — the target URL itself was not found by Jina.
        if (response.status === 404) {
          return {
            content: `Jina could not fetch the target URL (404)`,
            statusCode: 404,
            credits: 0,
            error: {
              code: ErrorCode.NOT_FOUND,
              message: 'Target URL not reachable by Jina Reader',
              retryable: false,
              statusCode: 404,
            },
          };
        }

        // 429 / 5xx — retryable.
        if (response.status === 429 || response.status >= 500) {
          lastError = classifyError({ status: response.status, message: content.slice(0, 200) });
          if (attempt < MAX_RETRIES) {
            const delayMs = calculateBackoff(attempt);
            mcpLog(
              'warning',
              `Jina ${response.status} on attempt ${attempt + 1}/${MAX_RETRIES + 1}. Retrying in ${delayMs}ms`,
              'jina',
            );
            await sleep(delayMs);
            continue;
          }
          return {
            content: `Jina Reader error (${response.status}): ${content.slice(0, 200)}`,
            statusCode: response.status,
            credits: 0,
            error: lastError,
          };
        }

        // Anything else — treat as non-retryable client error.
        return {
          content: `Jina Reader error (${response.status}): ${content.slice(0, 200)}`,
          statusCode: response.status,
          credits: 0,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: `Jina Reader returned ${response.status}`,
            retryable: false,
            statusCode: response.status,
          },
        };
      } catch (error) {
        lastError = classifyError(error);
        if (lastError.retryable && attempt < MAX_RETRIES) {
          const delayMs = calculateBackoff(attempt);
          mcpLog(
            'warning',
            `Jina ${lastError.code}: ${lastError.message}. Retry ${attempt + 1}/${MAX_RETRIES + 1} in ${delayMs}ms`,
            'jina',
          );
          await sleep(delayMs);
          continue;
        }
        return {
          content: `Jina Reader failed: ${lastError.message}`,
          statusCode: lastError.statusCode ?? 500,
          credits: 0,
          error: lastError,
        };
      }
    }

    return {
      content: `Jina Reader failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message ?? 'Unknown error'}`,
      statusCode: lastError?.statusCode ?? 500,
      credits: 0,
      error: lastError ?? { code: ErrorCode.UNKNOWN_ERROR, message: 'All retries exhausted', retryable: false },
    };
  }
}
