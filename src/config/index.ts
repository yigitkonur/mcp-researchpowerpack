/**
 * Consolidated configuration
 * All environment variables, constants, and LLM config in one place
 */

import { Logger } from 'mcp-use';

import { VERSION, PACKAGE_NAME, PACKAGE_DESCRIPTION } from '../version.js';

// Import version utilities (not re-exported - use directly from version.ts if needed externally)

// ============================================================================
// Safe Integer Parsing Helper
// ============================================================================

/**
 * Safely parse an integer from environment variable with bounds checking
 * @param value - The string value to parse (from process.env)
 * @param defaultVal - Default value if parsing fails or value is undefined
 * @param min - Minimum allowed value (clamped if below)
 * @param max - Maximum allowed value (clamped if above)
 * @returns Parsed integer within bounds, or default value
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

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  if (value && VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    return value as ReasoningEffort;
  }
  return 'high';
}

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

export function resetEnvCache(): void {
  cachedEnv = null;
  cachedResearch = null;
  cachedLlmExtraction = null;
}

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
// Research API Configuration
// ============================================================================

interface ResearchConfig {
  readonly BASE_URL: string;
  readonly MODEL: string;
  readonly FALLBACK_MODEL: string;
  readonly API_KEY: string;
  readonly TIMEOUT_MS: number;
  readonly REASONING_EFFORT: 'low' | 'medium' | 'high';
  readonly MAX_URLS: number;
}

let cachedResearch: ResearchConfig | null = null;

function getResearch(): ResearchConfig {
  if (cachedResearch) return cachedResearch;
  cachedResearch = {
    BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    MODEL: process.env.RESEARCH_MODEL || 'x-ai/grok-4-fast',
    FALLBACK_MODEL: process.env.RESEARCH_FALLBACK_MODEL || 'google/gemini-2.5-flash',
    API_KEY: process.env.OPENROUTER_API_KEY || '',
    TIMEOUT_MS: safeParseInt(process.env.API_TIMEOUT_MS, 1800000, 1000, 3600000),
    REASONING_EFFORT: parseReasoningEffort(process.env.DEFAULT_REASONING_EFFORT),
    MAX_URLS: safeParseInt(process.env.DEFAULT_MAX_URLS, 100, 10, 200),
  };
  return cachedResearch;
}

// Lazy proxy so existing code using RESEARCH.X still works
export const RESEARCH: ResearchConfig = new Proxy({} as ResearchConfig, {
  get(_target, prop: string) {
    return getResearch()[prop as keyof ResearchConfig];
  },
});

// ============================================================================
// MCP Server Configuration
// ============================================================================

// Version is now automatically read from package.json via version.ts
// No need to manually update version strings anymore!
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
  llmExtraction: boolean; // LLM_EXTRACTION_API_KEY or OPENROUTER_API_KEY
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
    search: '❌ **Search unavailable.** Set `SERPER_API_KEY` to enable `web-search` and `search-reddit`.\n\n👉 Get your free API key at: https://serper.dev (2,500 free queries)',
    scraping: '❌ **Web scraping unavailable.** Set `SCRAPEDO_API_KEY` to enable `scrape-links`.\n\n👉 Sign up at: https://scrape.do (1,000 free credits)',
    llmExtraction: '⚠️ **AI extraction disabled.** The `use_llm` and `what_to_extract` features require `LLM_EXTRACTION_API_KEY` or `OPENROUTER_API_KEY`.\n\nScraping will work but without intelligent content filtering.',
  };
  return messages[capability];
}

// ============================================================================
// Scraper Configuration (Scrape.do implementation)
// ============================================================================

// ============================================================================
// Concurrency Limits — tuned for 2-core deployments
//
// Bottleneck analysis (Node.js single-threaded event loop):
//   SEARCH:  Pure I/O + tiny JSON parse (~5KB). High concurrency safe.
//   SCRAPER: I/O + Turndown HTML→MD conversion (20-50ms/page, synchronous).
//            Too many concurrent = burst of responses blocks event loop.
//            20 concurrent × 30ms avg = 600ms worst-case event loop stall.
//   REDDIT:  I/O + moderate JSON. Reddit rate-limits at ~60 req/min.
//   LLM:    I/O-only locally, but remote inference uses multiple cores per
//            request. Default 10 keeps remote server responsive.
// ============================================================================

export const CONCURRENCY = {
  /** Serper API — tiny JSON responses, pure I/O, no CPU cost */
  SEARCH: 30,
  /** Scrape.do — HTML responses (50-500KB), Turndown conversion is CPU work */
  SCRAPER: 20,
  /** Reddit API — moderate payloads, aggressive rate limiting (60 req/min) */
  REDDIT: 10,
  /** LLM extraction — remote inference bottleneck. Tune via LLM_CONCURRENCY env */
  LLM_EXTRACTION: safeParseInt(process.env.LLM_CONCURRENCY, 10, 1, 50),
} as const;

export const SCRAPER = {
  BATCH_SIZE: 30,
  EXTRACTION_PREFIX: 'Extract from document only — never hallucinate or add external knowledge.',
  EXTRACTION_SUFFIX: 'First line = content, not preamble. No confirmation messages.',
} as const;

// ============================================================================
// Research Compression Prefix/Suffix
// ============================================================================

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
  EXTRACTION_SUFFIX: `
---

⚠️ IMPORTANT: Extract and synthesize the key insights, opinions, and recommendations from these Reddit discussions. Focus on:
- Common themes and consensus across posts
- Specific recommendations with context
- Contrasting viewpoints and debates
- Real-world experiences and lessons learned
- Technical details and implementation tips

Be comprehensive but concise. Prioritize actionable insights.

---`,
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
// LLM Extraction Model (uses OPENROUTER for scrape-links AI extraction)
// ============================================================================

type LlmReasoningEffort = ReasoningEffort | 'none';

function parseLlmReasoningEffort(value: string | undefined): LlmReasoningEffort {
  if (value === 'none') return 'none';
  if (value && VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    return value as ReasoningEffort;
  }
  return 'low';
}

interface LlmExtractionConfig {
  readonly MODEL: string;
  readonly BASE_URL: string;
  readonly API_KEY: string;
  readonly MAX_TOKENS: number;
  readonly REASONING_EFFORT: LlmReasoningEffort;
}

let cachedLlmExtraction: LlmExtractionConfig | null = null;

function getLlmExtraction(): LlmExtractionConfig {
  if (cachedLlmExtraction) return cachedLlmExtraction;
  cachedLlmExtraction = {
    MODEL: process.env.LLM_EXTRACTION_MODEL || 'gpt-5.4-mini',
    BASE_URL: process.env.LLM_EXTRACTION_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    API_KEY: process.env.LLM_EXTRACTION_API_KEY || process.env.OPENROUTER_API_KEY || '',
    MAX_TOKENS: 8000,
    REASONING_EFFORT: parseLlmReasoningEffort(process.env.LLM_EXTRACTION_REASONING),
  };
  return cachedLlmExtraction;
}

export const LLM_EXTRACTION: LlmExtractionConfig = new Proxy({} as LlmExtractionConfig, {
  get(_target, prop: string) {
    return getLlmExtraction()[prop as keyof LlmExtractionConfig];
  },
});

