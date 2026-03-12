/**
 * Deep Research Client
 * Handles research API requests with web search capabilities
 * Implements robust retry logic and NEVER crashes the server
 */

import OpenAI from 'openai';
import { RESEARCH } from '../config/index.js';
import { calculateBackoff } from '../utils/retry.js';
import {
  classifyError,
  sleep,
  ErrorCode,
  withRequestTimeout,
  withStallProtection,
  type StructuredError,
} from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';

// ── Constants ──

const DEFAULT_RESEARCH_CONCURRENCY = 3 as const;
const MAX_RESEARCH_RETRIES = 3 as const;
const RESEARCH_TEMPERATURE = 0.3 as const;
const RESEARCH_BASE_DELAY_MS = 5_000 as const;
const RESEARCH_MAX_DELAY_MS = 60_000 as const;
const DEFAULT_MAX_TOKENS = 32_000 as const;
const MAX_SEARCH_RESULTS_CAP = 30 as const;

/** Hard deadline for a single research API call */
const RESEARCH_REQUEST_DEADLINE_MS = 120_000 as const;

/** Stall detection — abort if no response for this duration */
const RESEARCH_STALL_TIMEOUT_MS = 90_000 as const;

// Retryable status codes for research API
const RETRYABLE_RESEARCH_CODES = new Set([429, 500, 502, 503, 504]);

// Models that use Gemini-style google_search tool instead of search_parameters
const GEMINI_STYLE_MODELS = new Set([
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.0-flash',
  'google/gemini-pro',
]);

// ── Interfaces ──

interface ResearchParams {
  readonly question: string;
  readonly systemPrompt?: string;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly maxSearchResults?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly responseFormat?: { readonly type: 'json_object' | 'text' };
}

export interface ResearchResponse {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly content: string;
  readonly finishReason?: string;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly sourcesUsed?: number;
  };
  readonly annotations?: ReadonlyArray<{
    readonly type: 'url_citation';
    readonly url: string;
    readonly title: string;
    readonly startIndex: number;
    readonly endIndex: number;
  }>;
  readonly error?: StructuredError;
}

/** OpenRouter extension for response messages with annotations */
interface OpenRouterMessage {
  readonly role: string;
  readonly content: string | null;
  readonly annotations?: readonly OpenRouterAnnotation[];
}

/** Single annotation from OpenRouter response */
interface OpenRouterAnnotation {
  readonly type: string;
  readonly url_citation?: {
    readonly url: string;
    readonly title?: string;
    readonly start_index?: number;
    readonly end_index?: number;
  };
  readonly [key: string]: unknown;
}

/** OpenRouter extensions to usage stats */
interface OpenRouterUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly num_sources_used?: number;
}

/** Raw response shape from OpenRouter API call */
interface OpenRouterRawResponse {
  readonly response: OpenAI.ChatCompletion;
  readonly choice: OpenAI.ChatCompletion.Choice | undefined;
  readonly message: OpenRouterMessage | undefined;
}

/** Options passed through the research execution pipeline */
interface ResearchExecutionOptions {
  readonly temperature: number;
  readonly reasoningEffort: 'low' | 'medium' | 'high';
  readonly maxTokens: number;
  readonly maxSearchResults: number;
  readonly responseFormat?: { readonly type: 'json_object' | 'text' };
}

// ── Helpers ──

/**
 * Check if a model uses Gemini-style google_search tool
 */
function isGeminiStyleModel(model: string): boolean {
  return GEMINI_STYLE_MODELS.has(model) || model.startsWith('google/gemini');
}

/**
 * Build the OpenRouter request payload based on model type.
 * Gemini models use tools with google_search, others use search_parameters.
 */
function buildResearchPayload(
  model: string,
  messages: ReadonlyArray<{ readonly role: 'system' | 'user'; readonly content: string }>,
  options: ResearchExecutionOptions,
): Record<string, unknown> {
  const { temperature, reasoningEffort, maxTokens, maxSearchResults, responseFormat } = options;

  if (isGeminiStyleModel(model)) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      tools: [
        {
          type: 'google_search',
          googleSearch: {},
        },
      ],
    };
    if (responseFormat) {
      payload.response_format = responseFormat;
    }
    return payload;
  }

  // Default: use search_parameters (for Grok, Perplexity, etc.)
  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature,
    reasoning_effort: reasoningEffort,
    max_completion_tokens: maxTokens,
    search_parameters: {
      mode: 'on',
      max_search_results: Math.min(maxSearchResults, MAX_SEARCH_RESULTS_CAP),
      return_citations: true,
      sources: [{ type: 'web' }],
    },
  };
  if (responseFormat) {
    payload.response_format = responseFormat;
  }
  return payload;
}

/**
 * Parse an OpenRouter raw response into a structured ResearchResponse.
 * Extracts content, token usage, and citation annotations.
 */
function parseResearchResponse(
  raw: OpenRouterRawResponse,
  model: string,
): ResearchResponse {
  const { response, choice, message } = raw;

  return {
    id: response.id || '',
    model: response.model || model,
    created: response.created || Date.now(),
    content: message?.content || '',
    finishReason: choice?.finish_reason ?? undefined,
    usage: response.usage ? {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
      sourcesUsed: (response.usage as unknown as OpenRouterUsage).num_sources_used,
    } : undefined,
    annotations: message?.annotations?.map((a: OpenRouterAnnotation) => ({
      type: 'url_citation' as const,
      url: a.url_citation?.url || '',
      title: a.url_citation?.title || '',
      startIndex: a.url_citation?.start_index || 0,
      endIndex: a.url_citation?.end_index || 0,
    })),
  };
}

// ── Client ──

export { DEFAULT_RESEARCH_CONCURRENCY, MAX_RESEARCH_RETRIES, RESEARCH_TEMPERATURE };

export class ResearchClient {
  private client: OpenAI;

  constructor() {
    if (!RESEARCH.API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required for research');
    }

    this.client = new OpenAI({
      baseURL: RESEARCH.BASE_URL,
      apiKey: RESEARCH.API_KEY,
      timeout: RESEARCH.TIMEOUT_MS,
      maxRetries: 0, // We handle retries ourselves
    });
  }

  /**
   * Check if an error is retryable for research requests
   */
  private isRetryableError(error: unknown): boolean {
    if (!error) return false;

    const err = error as {
      status?: number;
      code?: string;
      message?: string;
    };

    if (err.status && RETRYABLE_RESEARCH_CODES.has(err.status)) {
      return true;
    }

    const message = (err.message || '').toLowerCase();
    if (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('service unavailable') ||
      message.includes('connection') ||
      message.includes('stalled')
    ) {
      return true;
    }

    // Check for stall protection errors
    if (err.code === 'ESTALLED' || err.code === 'ETIMEDOUT') {
      return true;
    }

    return false;
  }

  /**
   * Make the API call to OpenRouter with retry logic.
   * Returns the raw response or null if all attempts fail.
   */
  private async callOpenRouter(
    payload: Record<string, unknown>,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ raw: OpenRouterRawResponse; error?: undefined } | { raw?: undefined; error: StructuredError }> {
    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt <= MAX_RESEARCH_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          mcpLog('warning', `Retry attempt ${attempt}/${MAX_RESEARCH_RETRIES} for ${model}`, 'research');
        }

        const response = await withStallProtection(
          (stallSignal) => withRequestTimeout(
            (timeoutSignal) => {
              // Merge all abort signals (external + stall + timeout)
              const mergedController = new AbortController();
              const abortMerged = () => mergedController.abort();
              signal?.addEventListener('abort', abortMerged, { once: true });
              stallSignal.addEventListener('abort', abortMerged, { once: true });
              timeoutSignal.addEventListener('abort', abortMerged, { once: true });

              return this.client.chat.completions.create(
                payload as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
                { signal: mergedController.signal }
              ).finally(() => {
                signal?.removeEventListener('abort', abortMerged);
                stallSignal.removeEventListener('abort', abortMerged);
                timeoutSignal.removeEventListener('abort', abortMerged);
              });
            },
            RESEARCH_REQUEST_DEADLINE_MS,
            `research (${model})`,
          ),
          RESEARCH_STALL_TIMEOUT_MS,
          2,
          `research (${model})`,
        );
        const choice = response.choices?.[0];
        const message = choice?.message as unknown as OpenRouterMessage;

        // Validate response — retry on empty
        if (!message?.content && !choice) {
          lastError = {
            code: ErrorCode.INTERNAL_ERROR,
            message: 'Research API returned empty response',
            retryable: true,
          };

          if (attempt < MAX_RESEARCH_RETRIES) {
            const delayMs = calculateBackoff(attempt, RESEARCH_BASE_DELAY_MS, RESEARCH_MAX_DELAY_MS);
            mcpLog('warning', `Empty response, retrying in ${delayMs}ms...`, 'research');
            await sleep(delayMs, signal);
            continue;
          }
        }

        return { raw: { response, choice, message } };

      } catch (error: unknown) {
        lastError = classifyError(error);

        const err = error as { status?: number; message?: string };
        mcpLog('error', `Error with ${model} (attempt ${attempt + 1}): ${lastError.message} (status: ${err.status})`, 'research');

        if (this.isRetryableError(error) && attempt < MAX_RESEARCH_RETRIES) {
          const delayMs = calculateBackoff(attempt, RESEARCH_BASE_DELAY_MS, RESEARCH_MAX_DELAY_MS);
          mcpLog('warning', `Retrying in ${delayMs}ms...`, 'research');
          try { await sleep(delayMs, signal); } catch { break; }
          continue;
        }

        break;
      }
    }

    return {
      error: lastError || {
        code: ErrorCode.UNKNOWN_ERROR,
        message: 'Unknown research error',
        retryable: false,
      },
    };
  }

  /**
   * Execute a single research request with a specific model.
   * Thin orchestrator: build payload → call API → parse response.
   */
  private async executeResearch(
    model: string,
    messages: ReadonlyArray<{ readonly role: 'system' | 'user'; readonly content: string }>,
    options: ResearchExecutionOptions,
    signal?: AbortSignal,
  ): Promise<ResearchResponse> {
    const payload = buildResearchPayload(model, messages, options);
    const result = await this.callOpenRouter(payload, model, signal);

    if (result.raw) {
      return parseResearchResponse(result.raw, model);
    }

    return {
      id: '',
      model,
      created: Date.now(),
      content: '',
      error: result.error,
    };
  }

  /**
   * Perform research with retry logic and fallback to secondary model
   * Returns a ResearchResponse - may contain error field on failure
   * NEVER throws - always returns a valid response object
   */
  async research(params: ResearchParams, signal?: AbortSignal): Promise<ResearchResponse> {
    const {
      question,
      systemPrompt,
      reasoningEffort = RESEARCH.REASONING_EFFORT,
      maxSearchResults = RESEARCH.MAX_URLS,
      maxTokens = DEFAULT_MAX_TOKENS,
      temperature = RESEARCH_TEMPERATURE,
      responseFormat,
    } = params;

    // Validate input
    if (!question?.trim()) {
      return {
        id: '',
        model: RESEARCH.MODEL,
        created: Date.now(),
        content: '',
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: 'Research question cannot be empty',
          retryable: false,
        },
      };
    }

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: question });

    const options: ResearchExecutionOptions = { temperature, reasoningEffort, maxTokens, maxSearchResults, responseFormat };

    // Try primary model first
    mcpLog('info', `Trying primary model: ${RESEARCH.MODEL}`, 'research');
    const primaryResult = await this.executeResearch(RESEARCH.MODEL, messages, options, signal);

    if (!primaryResult.error) {
      return primaryResult;
    }

    // Primary failed - try fallback model if different
    if (RESEARCH.FALLBACK_MODEL && RESEARCH.FALLBACK_MODEL !== RESEARCH.MODEL) {
      mcpLog('warning', `Primary model failed, trying fallback: ${RESEARCH.FALLBACK_MODEL}`, 'research');
      const fallbackResult = await this.executeResearch(RESEARCH.FALLBACK_MODEL, messages, options, signal);

      if (!fallbackResult.error) {
        return fallbackResult;
      }

      // Both failed - return the fallback error (more recent)
      mcpLog('error', `Both models failed. Primary: ${primaryResult.error?.message}, Fallback: ${fallbackResult.error?.message}`, 'research');
      return {
        ...fallbackResult,
        content: `Research failed with both models. Primary (${RESEARCH.MODEL}): ${primaryResult.error?.message}. Fallback (${RESEARCH.FALLBACK_MODEL}): ${fallbackResult.error?.message}`,
      };
    }

    // No fallback or same model - return primary error
    mcpLog('error', `All attempts failed: ${primaryResult.error?.message}`, 'research');
    return {
      ...primaryResult,
      content: `Research failed: ${primaryResult.error?.message}`,
    };
  }
}
