/**
 * Robust error handling utilities for MCP server
 * Ensures the server NEVER crashes and always returns structured responses
 */

import { mcpLog } from './logger.js';

// ============================================================================
// Error Codes (MCP-compliant)
// ============================================================================

export const ErrorCode = {
  // Retryable errors
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  
  // Non-retryable errors
  AUTH_ERROR: 'AUTH_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  
  // Internal errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

// ============================================================================
// Constants
// ============================================================================

const MAX_ERROR_MSG_LENGTH = 500 as const;

// ============================================================================
// Structured Error Types
// ============================================================================

export interface StructuredError {
  code: ErrorCodeType;
  message: string;
  retryable: boolean;
  statusCode?: number;
  cause?: string;
}

interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryableStatuses: readonly number[];
  readonly onRetry?: (attempt: number, error: StructuredError, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [408, 429, 500, 502, 503, 504, 510],
};

// ============================================================================
// Error Classification — Atomic Classifiers
// ============================================================================

/**
 * Classify DOMException (AbortError from AbortController timeouts)
 */
function classifyDomException(error: DOMException): StructuredError {
  if (error.name === 'AbortError') {
    return { code: ErrorCode.TIMEOUT, message: 'Request timed out', retryable: true };
  }
  return { code: ErrorCode.UNKNOWN_ERROR, message: error.message.substring(0, MAX_ERROR_MSG_LENGTH), retryable: false };
}

/**
 * Classify by Node.js error codes (ECONNREFUSED, ENOTFOUND, etc.)
 * Returns null if no matching code is found.
 */
function classifyByErrorCode(error: { code?: string; message?: string }): StructuredError | null {
  const errCode = error.code;
  if (!errCode) return null;

  if (errCode === 'ECONNREFUSED' || errCode === 'ENOTFOUND' || errCode === 'ECONNRESET') {
    return { code: ErrorCode.NETWORK_ERROR, message: `Network error: ${errCode}`, retryable: true, cause: error.message };
  }

  if (errCode === 'ECONNABORTED' || errCode === 'ETIMEDOUT') {
    return { code: ErrorCode.TIMEOUT, message: 'Request timed out', retryable: true, cause: error.message };
  }

  return null;
}

/**
 * Classify by HTTP status code extracted from error objects (axios-style, fetch-style, etc.)
 * Returns null if no status code is found.
 */
function classifyByStatusCode(error: { status?: number; statusCode?: number; response?: { status?: number }; message?: string }): StructuredError | null {
  const status = error.response?.status || error.status || error.statusCode;
  if (!status) return null;
  return classifyHttpError(status, error.message || String(error));
}

/**
 * Classify by error message patterns (timeout, rate-limit, auth, parse errors)
 * Returns null if no pattern matches.
 */
function classifyByMessage(message: string): StructuredError | null {
  const lower = message.toLowerCase();

  // Timeout patterns
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborterror')) {
    return { code: ErrorCode.TIMEOUT, message: 'Request timed out', retryable: true, cause: message };
  }

  // Rate-limit patterns
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded', retryable: true, cause: message };
  }

  // API key errors
  if (message.includes('API_KEY') || message.includes('api_key') || message.includes('Invalid API')) {
    return { code: ErrorCode.AUTH_ERROR, message: 'API key missing or invalid', retryable: false, cause: message };
  }

  // Parse errors
  if (message.includes('JSON') || message.includes('parse') || message.includes('Unexpected token')) {
    return { code: ErrorCode.PARSE_ERROR, message: 'Failed to parse response', retryable: false, cause: message };
  }

  return null;
}

/**
 * Catch-all fallback classification when no other classifier matches.
 */
function classifyFallback(message: string, cause?: unknown): StructuredError {
  return {
    code: ErrorCode.UNKNOWN_ERROR,
    message: message.substring(0, MAX_ERROR_MSG_LENGTH),
    retryable: false,
    cause: cause ? String(cause) : undefined,
  };
}

// ============================================================================
// Main Error Classification Pipeline
// ============================================================================

/**
 * Classify any error into a structured format.
 * NEVER throws — always returns a valid StructuredError.
 */
export function classifyError(error: unknown): StructuredError {
  if (error == null) {
    return { code: ErrorCode.UNKNOWN_ERROR, message: 'An unknown error occurred', retryable: false };
  }

  if (error instanceof DOMException) return classifyDomException(error);

  if (!isErrorLike(error)) {
    return { code: ErrorCode.UNKNOWN_ERROR, message: String(error).substring(0, MAX_ERROR_MSG_LENGTH), retryable: false };
  }

  return classifyByErrorCode(error)
    ?? classifyByStatusCode(error)
    ?? classifyByMessage(error.message ?? String(error))
    ?? classifyFallback(error.message ?? String(error), error.cause);
}

/**
 * Type guard for error-like objects with common error properties
 */
function isErrorLike(value: unknown): value is {
  message?: string;
  response?: { status?: number; data?: unknown };
  status?: number;
  statusCode?: number;
  code?: string;
  name?: string;
  cause?: unknown;
} {
  return typeof value === 'object' && value !== null;
}

/**
 * Classify HTTP status codes into structured errors.
 * Exhaustive switch with grouped default handling for unknown ranges.
 */
function classifyHttpError(status: number, message: string): StructuredError {
  switch (status) {
    case 400:
      return { code: ErrorCode.INVALID_INPUT, message: 'Bad request', retryable: false, statusCode: status };
    case 401:
      return { code: ErrorCode.AUTH_ERROR, message: 'Invalid API key', retryable: false, statusCode: status };
    case 403:
      return { code: ErrorCode.QUOTA_EXCEEDED, message: 'Access forbidden or quota exceeded', retryable: false, statusCode: status };
    case 404:
      return { code: ErrorCode.NOT_FOUND, message: 'Resource not found', retryable: false, statusCode: status };
    case 408:
      return { code: ErrorCode.TIMEOUT, message: 'Request timeout', retryable: true, statusCode: status };
    case 429:
      return { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded', retryable: true, statusCode: status };
    case 500:
      return { code: ErrorCode.INTERNAL_ERROR, message: 'Server error', retryable: true, statusCode: status };
    case 502:
      return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Bad gateway', retryable: true, statusCode: status };
    case 503:
      return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Service unavailable', retryable: true, statusCode: status };
    case 504:
      return { code: ErrorCode.TIMEOUT, message: 'Gateway timeout', retryable: true, statusCode: status };
    case 510:
      return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Request canceled', retryable: true, statusCode: status };
    default:
      if (status >= 500) {
        return { code: ErrorCode.SERVICE_UNAVAILABLE, message: `Server error: ${status}`, retryable: true, statusCode: status };
      }
      if (status >= 400) {
        return { code: ErrorCode.INVALID_INPUT, message: `Client error: ${status}`, retryable: false, statusCode: status };
      }
      return { code: ErrorCode.UNKNOWN_ERROR, message: `HTTP ${status}: ${message.substring(0, MAX_ERROR_MSG_LENGTH)}`, retryable: false, statusCode: status };
  }
}

// ============================================================================
// Retry Logic with Exponential Backoff
// ============================================================================

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoff(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, options.maxDelayMs);
}

/**
 * Sleep utility that respects abort signals
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    function onAbort() {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    }

    const timeout = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
    // Re-check: signal may have aborted between initial check and listener registration
    if (signal?.aborted) {
      onAbort();
    }
  });
}

/**
 * Wrap a fetch call with timeout via AbortController
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30000, signal: externalSignal, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal.aborted) {
      controller.abort();
    }
  }

  return fetch(url, { ...fetchOptions, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  });
}

// ============================================================================
// MCP Tool Error Response Types (for client-facing error responses)
// ============================================================================

/**
 * MCP-compliant error codes for tool responses
 * These codes are exposed to clients for programmatic error handling
 */
export const MCP_ERROR_CODES = {
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type McpErrorCodeType = typeof MCP_ERROR_CODES[keyof typeof MCP_ERROR_CODES];

/**
 * Structured response type for MCP tool errors
 * Per MCP spec: tools return isError:true for recoverable/tool-level failures
 * Uses index signature for SDK compatibility with additional fields
 */
interface ToolErrorResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  errorCode?: McpErrorCodeType;
  retryAfter?: number; // Seconds to wait before retry (for rate limits)
  [key: string]: unknown; // Allow additional fields for SDK compatibility
}

/**
 * Map internal ErrorCode to client-facing MCP_ERROR_CODES
 */
function mapErrorCodeToMCP(code: ErrorCodeType): McpErrorCodeType {
  switch (code) {
    case ErrorCode.RATE_LIMITED:
    case ErrorCode.QUOTA_EXCEEDED:
      return MCP_ERROR_CODES.RATE_LIMITED;
    case ErrorCode.TIMEOUT:
      return MCP_ERROR_CODES.TIMEOUT;
    case ErrorCode.NETWORK_ERROR:
      return MCP_ERROR_CODES.NETWORK_ERROR;
    case ErrorCode.SERVICE_UNAVAILABLE:
      return MCP_ERROR_CODES.SERVICE_UNAVAILABLE;
    case ErrorCode.AUTH_ERROR:
      return MCP_ERROR_CODES.AUTH_ERROR;
    case ErrorCode.NOT_FOUND:
      return MCP_ERROR_CODES.NOT_FOUND;
    case ErrorCode.INVALID_INPUT:
    case ErrorCode.PARSE_ERROR:
      return MCP_ERROR_CODES.VALIDATION_ERROR;
    case ErrorCode.INTERNAL_ERROR:
    case ErrorCode.UNKNOWN_ERROR:
    default:
      return MCP_ERROR_CODES.INTERNAL_ERROR;
  }
}

/**
 * Create a standardized MCP tool error response
 * @param message - Human-readable error message
 * @param errorCode - Optional MCP error code for programmatic handling
 * @param retryAfter - Optional seconds to wait before retry (for rate limits)
 */
function createToolError(
  message: string,
  errorCode?: McpErrorCodeType,
  retryAfter?: number
): ToolErrorResponse {
  const response: ToolErrorResponse = {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
  
  if (errorCode) {
    response.errorCode = errorCode;
  }
  
  if (retryAfter !== undefined && retryAfter > 0) {
    response.retryAfter = retryAfter;
  }
  
  return response;
}

/**
 * Create a tool error response from a StructuredError
 * Automatically maps error codes and calculates retryAfter for rate limits
 */
export function createToolErrorFromStructured(
  structuredError: StructuredError,
  attempt: number = 0
): ToolErrorResponse {
  const errorCode = mapErrorCodeToMCP(structuredError.code);
  
  // Calculate retryAfter for rate-limited errors
  let retryAfter: number | undefined;
  if (structuredError.retryable && errorCode === MCP_ERROR_CODES.RATE_LIMITED) {
    retryAfter = Math.ceil(calculateBackoff(attempt, DEFAULT_RETRY_OPTIONS) / 1000);
  }
  
  // Format user-friendly error message
  const retryHint = structuredError.retryable 
    ? '\n\n💡 This error may be temporary. Try again in a moment.' 
    : '';
  const errorText = `## ❌ Error\n\n**${structuredError.code}:** ${structuredError.message}${retryHint}\n\nPlease check your input parameters and try again.`;
  
  return createToolError(errorText, errorCode, retryAfter);
}

// ============================================================================
// Stability Wrappers — Network resilience for LLM API calls
// ============================================================================

/**
 * Wrap a promise with a hard deadline timeout.
 * If the promise doesn't resolve/reject within `timeoutMs`, it rejects with a timeout error.
 * Uses AbortController to signal cancellation to the underlying request.
 */
export function withRequestTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string = 'request',
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fn(controller.signal).finally(() => clearTimeout(timeoutId)).catch((err) => {
    if (controller.signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
      throw Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
        code: 'ETIMEDOUT',
        retryable: true,
      });
    }
    throw err;
  });
}

/**
 * Wrap a non-streaming API call with activity-based timeout detection.
 * If the call hasn't completed within `stallMs`, abort and retry.
 * This catches "stuck" connections where TCP stays open but no data flows.
 *
 * @param fn - Async function that accepts an AbortSignal
 * @param stallMs - Max milliseconds to wait for the call to complete before considering it stuck
 * @param maxAttempts - Max retry attempts for stalled requests
 * @param label - Label for log messages
 * @returns The result of the function
 */
export async function withStallProtection<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  stallMs: number,
  maxAttempts: number = 2,
  label: string = 'request',
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const stallPromise = new Promise<never>((_, reject) => {
      stallTimer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`${label} stalled — no response for ${stallMs}ms (attempt ${attempt + 1}/${maxAttempts})`), {
          code: 'ESTALLED',
          retryable: attempt < maxAttempts - 1,
        }));
      }, stallMs);
    });

    let fnPromise: Promise<T> | undefined;
    try {
      fnPromise = fn(controller.signal);
      const result = await Promise.race([fnPromise, stallPromise]);
      clearTimeout(stallTimer);
      return result;
    } catch (err) {
      // Suppress unhandled rejection from the losing promise
      // (e.g. fnPromise rejects after stallPromise wins the race)
      fnPromise?.catch(() => {});
      clearTimeout(stallTimer);
      const isStall = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ESTALLED';
      if (isStall && attempt < maxAttempts - 1) {
        const backoff = calculateBackoff(attempt, DEFAULT_RETRY_OPTIONS);
        mcpLog('warning', `${label} stalled, retrying in ${backoff}ms (attempt ${attempt + 1})`, 'stability');
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  // Should never reach here, but TypeScript needs it
  throw new Error(`${label} failed after ${maxAttempts} stall-protection attempts`);
}
