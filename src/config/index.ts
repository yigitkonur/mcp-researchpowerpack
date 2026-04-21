/**
 * Consolidated configuration
 * All environment variables, constants, and LLM config in one place
 */

import { Logger } from 'mcp-use';

import { VERSION, PACKAGE_NAME, PACKAGE_DESCRIPTION } from '../version.js';

// ============================================================================
// Safe Integer Parsing Helper
// ============================================================================

/**
 * Safely parse an integer from environment variable with bounds checking
 */
function safeParseInt(
  value: string | undefined,
  defaultVal: number,
  min: number,
  max: number
): number {
  const logger = Logger.get('config');

  if (!value) {
    return defaultVal;
  }

  const parsed = parseInt(value, 10);

  if (isNaN(parsed)) {
    logger.warn(`Invalid number "${value}", using default ${defaultVal}`);
    return defaultVal;
  }

  if (parsed < min) {
    logger.warn(`Value ${parsed} below minimum ${min}, clamping to ${min}`);
    return min;
  }

  if (parsed > max) {
    logger.warn(`Value ${parsed} above maximum ${max}, clamping to ${max}`);
    return max;
  }

  return parsed;
}

// ============================================================================
// Reasoning Effort Validation
// ============================================================================

const VALID_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];

// ============================================================================
// Environment Parsing
// ============================================================================

interface EnvConfig {
  SCRAPER_API_KEY: string;
  SEARCH_API_KEY: string | undefined;
  REDDIT_CLIENT_ID: string | undefined;
  REDDIT_CLIENT_SECRET: string | undefined;
}

let cachedEnv: EnvConfig | null = null;

export function parseEnv(): EnvConfig {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    SCRAPER_API_KEY: process.env.SCRAPEDO_API_KEY || '',
    SEARCH_API_KEY: process.env.SERPER_API_KEY || undefined,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || undefined,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || undefined,
  };
  return cachedEnv;
}

// ============================================================================
// MCP Server Configuration
// ============================================================================

export const SERVER = {
  NAME: PACKAGE_NAME,
  VERSION: VERSION,
  DESCRIPTION: PACKAGE_DESCRIPTION,
} as const;

// ============================================================================
// Capability Detection (which features are available based on ENV)
// ============================================================================

export interface Capabilities {
  reddit: boolean;        // REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET
  search: boolean;        // SERPER_API_KEY
  scraping: boolean;      // SCRAPEDO_API_KEY
  llmExtraction: boolean; // LLM_API_KEY (or legacy: LLM_EXTRACTION_API_KEY, OPENROUTER_API_KEY)
}

export function getCapabilities(): Capabilities {
  const env = parseEnv();
  return {
    reddit: !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET),
    search: !!env.SEARCH_API_KEY,
    scraping: !!env.SCRAPER_API_KEY,
    llmExtraction: !!LLM_EXTRACTION.API_KEY,
  };
}

export function getMissingEnvMessage(capability: keyof Capabilities): string {
  const messages: Record<keyof Capabilities, string> = {
    reddit: '❌ **Reddit tools unavailable.** Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` to enable `get-reddit-post`.\n\n👉 Create a Reddit app at: https://www.reddit.com/prefs/apps (select "script" type)',
    search: '❌ **Search unavailable.** Set `SERPER_API_KEY` to enable `web-search` (including `scope: "reddit"`).\n\n👉 Get your free API key at: https://serper.dev (2,500 free queries)',
    scraping: '❌ **Web scraping unavailable.** Set `SCRAPEDO_API_KEY` to enable `scrape-links`.\n\n👉 Sign up at: https://scrape.do (1,000 free credits)',
    llmExtraction: '⚠️ **AI extraction disabled.** Set `LLM_API_KEY` to enable AI-powered content extraction and search classification.\n\nScraping will work but without intelligent content filtering.',
  };
  return messages[capability];
}

// ============================================================================
// Concurrency Limits
// ============================================================================

export const CONCURRENCY = {
  SEARCH: safeParseInt(process.env.CONCURRENCY_SEARCH, 50, 1, 200),
  SCRAPER: safeParseInt(process.env.CONCURRENCY_SCRAPER, 50, 1, 200),
  REDDIT: safeParseInt(process.env.CONCURRENCY_REDDIT, 50, 1, 200),
  LLM_EXTRACTION: safeParseInt(
    process.env.LLM_CONCURRENCY || process.env.LLM_EXTRACTION_CONCURRENCY,
    50, 1, 200,
  ),
} as const;

export const SCRAPER = {
  BATCH_SIZE: 30,
  EXTRACTION_PREFIX: 'Extract from document only — never hallucinate or add external knowledge.',
  EXTRACTION_SUFFIX: 'First line = content, not preamble. No confirmation messages.',
} as const;

// ============================================================================
// Reddit Configuration
// ============================================================================

export const REDDIT = {
  BATCH_SIZE: 10,
  MAX_WORDS_PER_POST: 50_000,
  MAX_WORDS_TOTAL: 500_000,
  MIN_POSTS: 1,
  MAX_POSTS: 50,
  RETRY_COUNT: 5,
  RETRY_DELAYS: [2000, 4000, 8000, 16000, 32000] as const,
} as const;

// ============================================================================
// CTR Weights for URL Ranking (inspired from CTR research)
// ============================================================================

export const CTR_WEIGHTS: Record<number, number> = {
  1: 100.00,
  2: 60.00,
  3: 48.89,
  4: 33.33,
  5: 28.89,
  6: 26.44,
  7: 24.44,
  8: 17.78,
  9: 13.33,
  10: 12.56,
} as const;

// ============================================================================
// LLM Configuration
//
// Env var naming: LLM_* (canonical) with backwards-compatible fallbacks.
// LLM_API_KEY + LLM_BASE_URL + LLM_MODEL are all required together — no defaults.
// Fallback chain per variable:
//   LLM_API_KEY      ← LLM_EXTRACTION_API_KEY  ← OPENROUTER_API_KEY
//   LLM_BASE_URL     ← LLM_EXTRACTION_BASE_URL ← OPENROUTER_BASE_URL
//   LLM_MODEL        ← LLM_EXTRACTION_MODEL
//   LLM_REASONING    ← LLM_EXTRACTION_REASONING                       ← 'none'
//   LLM_CONCURRENCY  ← LLM_EXTRACTION_CONCURRENCY                     ← 50
// ============================================================================

type LlmReasoningEffort = ReasoningEffort | 'none';

function parseLlmReasoningEffort(value: string | undefined): LlmReasoningEffort {
  if (!value || value === 'none') return 'none';
  if (VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    return value as ReasoningEffort;
  }
  return 'none';
}

interface LlmExtractionConfig {
  readonly MODEL: string;
  readonly BASE_URL: string;
  readonly API_KEY: string;
  readonly REASONING_EFFORT: LlmReasoningEffort;
}

/** Read an env var with a backwards-compatible fallback chain */
function envWithFallback(...names: string[]): string | undefined {
  for (const name of names) {
    const val = process.env[name]?.trim();
    if (val) return val;
  }
  return undefined;
}

let cachedLlmExtraction: LlmExtractionConfig | null = null;

function getLlmExtraction(): LlmExtractionConfig {
  if (cachedLlmExtraction) return cachedLlmExtraction;

  const apiKey = envWithFallback('LLM_API_KEY', 'LLM_EXTRACTION_API_KEY', 'OPENROUTER_API_KEY') || '';
  const baseUrl = envWithFallback('LLM_BASE_URL', 'LLM_EXTRACTION_BASE_URL', 'OPENROUTER_BASE_URL');
  const model = envWithFallback('LLM_MODEL', 'LLM_EXTRACTION_MODEL');

  if (apiKey && !baseUrl) {
    throw new Error(
      'LLM_BASE_URL is required when LLM_API_KEY is set. ' +
      'Set LLM_BASE_URL to your OpenAI-compatible endpoint (e.g. https://openrouter.ai/api/v1, https://api.openai.com/v1, https://api.cerebras.ai/v1).',
    );
  }
  if (apiKey && !model) {
    throw new Error(
      'LLM_MODEL is required when LLM_API_KEY is set. ' +
      'Set LLM_MODEL to a model identifier your endpoint accepts (e.g. openai/gpt-4.1-mini, gpt-4o, llama-3.3-70b).',
    );
  }

  cachedLlmExtraction = {
    API_KEY: apiKey,
    BASE_URL: baseUrl || '',
    MODEL: model || '',
    REASONING_EFFORT: parseLlmReasoningEffort(envWithFallback('LLM_REASONING', 'LLM_EXTRACTION_REASONING')),
  };
  return cachedLlmExtraction;
}

export const LLM_EXTRACTION: LlmExtractionConfig = new Proxy({} as LlmExtractionConfig, {
  get(_target, prop: string) {
    return getLlmExtraction()[prop as keyof LlmExtractionConfig];
  },
});
