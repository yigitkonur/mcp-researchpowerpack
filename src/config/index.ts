/**
 * Consolidated configuration
 * All environment variables, constants, and LLM config in one place
 */

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
  if (!value) {
    return defaultVal;
  }
  
  const parsed = parseInt(value, 10);
  
  if (isNaN(parsed)) {
    console.warn(`[Config] Invalid number "${value}", using default ${defaultVal}`);
    return defaultVal;
  }
  
  if (parsed < min) {
    console.warn(`[Config] Value ${parsed} below minimum ${min}, clamping to ${min}`);
    return min;
  }
  
  if (parsed > max) {
    console.warn(`[Config] Value ${parsed} above maximum ${max}, clamping to ${max}`);
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
    REASONING_EFFORT: (process.env.DEFAULT_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'high',
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
  deepResearch: boolean;  // OPENROUTER_API_KEY
  llmExtraction: boolean; // OPENROUTER_API_KEY (for what_to_extract in scraping)
}

export function getCapabilities(): Capabilities {
  const env = parseEnv();
  return {
    reddit: !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET),
    search: !!env.SEARCH_API_KEY,
    scraping: !!env.SCRAPER_API_KEY,
    deepResearch: !!RESEARCH.API_KEY,
    llmExtraction: !!RESEARCH.API_KEY, // Reuses OPENROUTER for LLM extraction
  };
}

export function getMissingEnvMessage(capability: keyof Capabilities): string {
  const messages: Record<keyof Capabilities, string> = {
    reddit: '❌ **Reddit tools unavailable.** Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` to enable.\n\n👉 Create a Reddit app at: https://www.reddit.com/prefs/apps (select "script" type)',
    search: '❌ **Search unavailable.** Set `SERPER_API_KEY` to enable web search and Reddit search.\n\n👉 Get your free API key at: https://serper.dev (2,500 free queries)',
    scraping: '❌ **Web scraping unavailable.** Set `SCRAPEDO_API_KEY` to enable URL content extraction.\n\n👉 Sign up at: https://scrape.do (1,000 free credits)',
    deepResearch: '❌ **Deep research unavailable.** Set `OPENROUTER_API_KEY` to enable AI-powered research.\n\n👉 Get your API key at: https://openrouter.ai/keys',
    llmExtraction: '⚠️ **AI extraction disabled.** The `use_llm` and `what_to_extract` features require `OPENROUTER_API_KEY`.\n\nScraping will work but without intelligent content filtering.',
  };
  return messages[capability];
}

// ============================================================================
// Scraper Configuration (Scrape.do implementation)
// ============================================================================

export const SCRAPER = {
  MAX_CONCURRENT: 30,
  BATCH_SIZE: 30,
  MAX_TOKENS_BUDGET: 32000,
  MIN_URLS: 3,
  MAX_URLS: 50,
  RETRY_COUNT: 3,
  RETRY_DELAYS: [2000, 4000, 8000] as const,
  EXTRACTION_PREFIX: 'Extract ONLY from document — never hallucinate. For structured data (pricing, specs, features) → markdown table. Otherwise → tight bullet points. No intro, no confirmation message, no meta-commentary.',
  EXTRACTION_SUFFIX: 'Output grounded info only. First line = content, not preamble.',
} as const;

// ============================================================================
// Research Compression Prefix/Suffix
// ============================================================================

export const RESEARCH_PROMPTS = {
  SUFFIX: `CONSTRAINTS: No restating the question. No hedging preambles. Cite sources inline [source]. NEVER hallucinate — only report what sources confirm.`,
} as const;

// ============================================================================
// Reddit Configuration
// ============================================================================

export const REDDIT = {
  MAX_CONCURRENT: 10,
  BATCH_SIZE: 10,
  MAX_COMMENT_BUDGET: 1000,
  MAX_COMMENTS_PER_POST: 200,
  MIN_POSTS: 2,
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
// LLM Extraction Model (uses OPENROUTER for scrape_links AI extraction)
// ============================================================================

interface LlmExtractionConfig {
  readonly MODEL: string;
  readonly MAX_TOKENS: number;
  readonly ENABLE_REASONING: boolean;
}

let cachedLlmExtraction: LlmExtractionConfig | null = null;

function getLlmExtraction(): LlmExtractionConfig {
  if (cachedLlmExtraction) return cachedLlmExtraction;
  cachedLlmExtraction = {
    MODEL: process.env.LLM_EXTRACTION_MODEL || 'openai/gpt-oss-120b:nitro',
    MAX_TOKENS: 8000,
    ENABLE_REASONING: process.env.LLM_ENABLE_REASONING !== 'false',
  };
  return cachedLlmExtraction;
}

export const LLM_EXTRACTION: LlmExtractionConfig = new Proxy({} as LlmExtractionConfig, {
  get(_target, prop: string) {
    return getLlmExtraction()[prop as keyof LlmExtractionConfig];
  },
});
