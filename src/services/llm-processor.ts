/**
 * LLM Processor for content extraction
 * Uses OpenRouter via OPENROUTER_API_KEY for AI-powered content filtering
 * Implements robust retry logic and NEVER throws
 */

import OpenAI from 'openai';
import { LLM_EXTRACTION, getCapabilities } from '../config/index.js';
import {
  classifyError,
  sleep,
  ErrorCode,
  withStallProtection,
  type StructuredError,
} from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';

/** Maximum input characters for LLM processing (~25k tokens) */
const MAX_LLM_INPUT_CHARS = 100_000 as const;

/** LLM client timeout in milliseconds */
const LLM_CLIENT_TIMEOUT_MS = 120_000 as const;

/** Jitter factor for exponential backoff */
const BACKOFF_JITTER_FACTOR = 0.3 as const;

/** Stall detection timeout — abort if no response in this time */
const LLM_STALL_TIMEOUT_MS = 15_000 as const;

/** Hard request deadline for LLM calls */
const LLM_REQUEST_DEADLINE_MS = 30_000 as const;

interface ProcessingConfig {
  readonly use_llm: boolean;
  readonly what_to_extract: string | undefined;
  readonly max_tokens?: number;
}

interface LLMResult {
  readonly content: string;
  readonly processed: boolean;
  readonly error?: string;
  readonly errorDetails?: StructuredError;
}

// LLM-specific retry configuration
const LLM_RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 5000,
} as const;

// OpenRouter/OpenAI specific retryable error codes (using Set for type-safe lookup)
const RETRYABLE_LLM_ERROR_CODES = new Set([
  'rate_limit_exceeded',
  'server_error',
  'timeout',
  'service_unavailable',
]);

/** Type guard for errors with an HTTP status code */
function hasStatus(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as Record<string, unknown>).status === 'number'
  );
}

let llmClient: OpenAI | null = null;

export function createLLMProcessor(): OpenAI | null {
  if (!getCapabilities().llmExtraction) return null;

  if (!llmClient) {
    llmClient = new OpenAI({
      baseURL: LLM_EXTRACTION.BASE_URL,
      apiKey: LLM_EXTRACTION.API_KEY,
      timeout: LLM_CLIENT_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: { 'X-Title': 'mcp-research-powerpack' },
    });
    mcpLog('info', `LLM extraction configured (model: ${LLM_EXTRACTION.MODEL}, baseURL: ${LLM_EXTRACTION.BASE_URL})`, 'llm');
  }
  return llmClient;
}

/**
 * Check if an LLM error is retryable
 */
function isRetryableLLMError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  // Stall/timeout protection errors - always retry these
  const stallCode = (error as { code?: string })?.code;
  if (stallCode === 'ESTALLED' || stallCode === 'ETIMEDOUT') {
    return true;
  }

  // Check HTTP status codes
  if (hasStatus(error)) {
    if (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504) {
      return true;
    }
  }

  // Check error codes from OpenAI/OpenRouter
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  const nested =
    typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>)
      : null;
  const errorCode =
    code ??
    (nested && typeof nested.code === 'string' ? nested.code : undefined) ??
    (nested && typeof nested.type === 'string' ? nested.type : undefined);
  if (errorCode && RETRYABLE_LLM_ERROR_CODES.has(errorCode)) {
    return true;
  }

  // Check message for common patterns
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  if (
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('service unavailable') ||
    message.includes('server error') ||
    message.includes('connection') ||
    message.includes('econnreset')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate backoff delay with jitter for LLM retries
 */
function calculateLLMBackoff(attempt: number): number {
  const exponentialDelay = LLM_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * BACKOFF_JITTER_FACTOR * exponentialDelay;
  return Math.min(exponentialDelay + jitter, LLM_RETRY_CONFIG.maxDelayMs);
}

/**
 * Process content with LLM extraction
 * NEVER throws - always returns a valid LLMResult
 * Implements retry logic with exponential backoff for transient failures
 */
export async function processContentWithLLM(
  content: string,
  config: ProcessingConfig,
  processor?: OpenAI | null,
  signal?: AbortSignal
): Promise<LLMResult> {
  // Early returns for invalid/skip conditions
  if (!config.use_llm) {
    return { content, processed: false };
  }

  if (!processor) {
    return {
      content,
      processed: false,
      error: 'LLM processor not available (LLM_EXTRACTION_API_KEY or OPENROUTER_API_KEY not set)',
      errorDetails: {
        code: ErrorCode.AUTH_ERROR,
        message: 'LLM processor not available',
        retryable: false,
      },
    };
  }

  if (!content?.trim()) {
    return { content: content || '', processed: false, error: 'Empty content provided' };
  }

  // Truncate extremely long content to avoid token limits
  const truncatedContent = content.length > MAX_LLM_INPUT_CHARS
    ? content.substring(0, MAX_LLM_INPUT_CHARS) + '\n\n[Content truncated due to length]'
    : content;

  const prompt = config.what_to_extract
    ? `Extract and clean the following content. Focus on: ${config.what_to_extract}\n\nContent:\n${truncatedContent}`
    : `Clean and extract the main content from the following text, removing navigation, ads, and irrelevant elements:\n\n${truncatedContent}`;

  const activeModel = LLM_EXTRACTION.MODEL;

  // Build request body
  const requestBody: Record<string, unknown> = {
    model: activeModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: config.max_tokens || LLM_EXTRACTION.MAX_TOKENS,
  };

  if (LLM_EXTRACTION.REASONING_EFFORT !== 'none') {
    requestBody.reasoning_effort = LLM_EXTRACTION.REASONING_EFFORT;
  }

  let lastError: StructuredError | undefined;

  // Retry loop
  for (let attempt = 0; attempt <= LLM_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      if (attempt === 0) {
        mcpLog('info', `Starting extraction with ${activeModel}`, 'llm');
      } else {
        mcpLog('warning', `Retry attempt ${attempt}/${LLM_RETRY_CONFIG.maxRetries}`, 'llm');
      }

      const response = await withStallProtection(
        (stallSignal) => processor.chat.completions.create(
          requestBody as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
          {
            signal: signal ? AbortSignal.any([stallSignal, signal]) : stallSignal,
            timeout: LLM_REQUEST_DEADLINE_MS,
          },
        ),
        LLM_STALL_TIMEOUT_MS,
        3,
        `LLM extraction (${activeModel})`,
      );

      const result = response.choices?.[0]?.message?.content;
      if (result && result.trim()) {
        mcpLog('info', `Successfully extracted ${result.length} characters`, 'llm');
        return { content: result, processed: true };
      }

      // Empty response - not retryable
      mcpLog('warning', 'Received empty response from LLM', 'llm');
      return {
        content,
        processed: false,
        error: 'LLM returned empty response',
        errorDetails: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'LLM returned empty response',
          retryable: false,
        },
      };

    } catch (err: unknown) {
      lastError = classifyError(err);

      // Log the error
      const status = hasStatus(err) ? err.status : undefined;
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as Record<string, unknown>).code)
        : undefined;
      mcpLog('error', `Error (attempt ${attempt + 1}): ${lastError.message} [status=${status}, code=${code}, retryable=${isRetryableLLMError(err)}]`, 'llm');

      // Check if we should retry
      if (isRetryableLLMError(err) && attempt < LLM_RETRY_CONFIG.maxRetries) {
        const delayMs = calculateLLMBackoff(attempt);
        mcpLog('warning', `Retrying in ${delayMs}ms...`, 'llm');
        try { await sleep(delayMs, signal); } catch { break; }
        continue;
      }

      // Non-retryable or max retries reached
      break;
    }
  }

  // All attempts failed - return original content with error info
  const errorMessage = lastError?.message || 'Unknown LLM error';
  mcpLog('error', `All attempts failed: ${errorMessage}. Returning original content.`, 'llm');

  return {
    content, // Return original content as fallback
    processed: false,
    error: `LLM extraction failed: ${errorMessage}`,
    errorDetails: lastError || {
      code: ErrorCode.UNKNOWN_ERROR,
      message: errorMessage,
      retryable: false,
    },
  };
}

