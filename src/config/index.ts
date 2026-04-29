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
// Environment Parsing
// ============================================================================

interface EnvConfig {
  SCRAPER_API_KEY: string;
  SEARCH_API_KEY: string | undefined;
  REDDIT_CLIENT_ID: string | undefined;
  REDDIT_CLIENT_SECRET: string | undefined;
  JINA_API_KEY: string | undefined;
}

let cachedEnv: EnvConfig | null = null;

export function parseEnv(): EnvConfig {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    SCRAPER_API_KEY: process.env.SCRAPEDO_API_KEY || '',
    SEARCH_API_KEY: process.env.SERPER_API_KEY || undefined,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || undefined,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || undefined,
    JINA_API_KEY: process.env.JINA_API_KEY || undefined,
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
  llmExtraction: boolean; // LLM_API_KEY
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
    llmExtraction: '⚠️ **AI extraction disabled.** Set `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` to enable AI-powered content extraction and search classification.\n\nScraping will work but without intelligent content filtering.',
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
  LLM_EXTRACTION: safeParseInt(process.env.LLM_CONCURRENCY, 50, 1, 200),
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
// Required vars (all must be set together when LLM is enabled):
//   LLM_API_KEY      — API key for the OpenAI-compatible endpoint
//   LLM_BASE_URL     — endpoint base URL (e.g. https://server.up.railway.app/v1)
//   LLM_MODEL        — primary model (e.g. gpt-5.4-mini)
//
// Optional:
//   LLM_FALLBACK_MODEL — model to use after primary exhausts all retries (e.g. gpt-5.4)
//   LLM_CONCURRENCY    — parallel LLM calls (default: 50)
//
// Reasoning effort is always 'low' — not configurable.
// ============================================================================

interface LlmExtractionConfig {
  readonly MODEL: string;
  readonly FALLBACK_MODEL: string;
  readonly BASE_URL: string;
  readonly API_KEY: string;
}

let cachedLlmExtraction: LlmExtractionConfig | null = null;

function getLlmExtraction(): LlmExtractionConfig {
  if (cachedLlmExtraction) return cachedLlmExtraction;

  const apiKey = process.env.LLM_API_KEY?.trim() || '';
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim();
  const fallbackModel = process.env.LLM_FALLBACK_MODEL?.trim() || '';

  if (apiKey && !baseUrl) {
    throw new Error(
      'LLM_BASE_URL is required when LLM_API_KEY is set. ' +
      'Set LLM_BASE_URL to your OpenAI-compatible endpoint.',
    );
  }
  if (apiKey && !model) {
    throw new Error(
      'LLM_MODEL is required when LLM_API_KEY is set.',
    );
  }

  cachedLlmExtraction = {
    API_KEY: apiKey,
    BASE_URL: baseUrl || '',
    MODEL: model || '',
    FALLBACK_MODEL: fallbackModel,
  };
  return cachedLlmExtraction;
}

export const LLM_EXTRACTION: LlmExtractionConfig = new Proxy({} as LlmExtractionConfig, {
  get(_target, prop: string) {
    return getLlmExtraction()[prop as keyof LlmExtractionConfig];
  },
});
