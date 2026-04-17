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
  readonly enabled: boolean;
  readonly extract: string | undefined;
  readonly max_tokens?: number;
  readonly url?: string;
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

type OpenAITextGenerator = Pick<OpenAI, 'chat'>;

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

function buildChatRequestBody(model: string, prompt: string, maxTokens: number): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };

  if (LLM_EXTRACTION.REASONING_EFFORT !== 'none') {
    requestBody.reasoning_effort = LLM_EXTRACTION.REASONING_EFFORT;
  }

  return requestBody;
}

export async function requestTextWithFallback(
  processor: OpenAITextGenerator,
  prompt: string,
  maxTokens: number,
  operationLabel: string,
  signal?: AbortSignal,
): Promise<{ content: string | null; model: string; error?: string }> {
  const models = [...new Set([
    LLM_EXTRACTION.MODEL,
    LLM_EXTRACTION.FALLBACK_MODEL,
  ].filter(Boolean))];

  let lastError = 'Unknown LLM error';

  for (const model of models) {
    try {
      const response = await withStallProtection(
        (stallSignal) => processor.chat.completions.create(
          buildChatRequestBody(model, prompt, maxTokens) as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
          {
            signal: signal ? AbortSignal.any([stallSignal, signal]) : stallSignal,
            timeout: LLM_REQUEST_DEADLINE_MS,
          },
        ),
        LLM_STALL_TIMEOUT_MS,
        3,
        `${operationLabel} (${model})`,
      );

      const content = response.choices?.[0]?.message?.content?.trim();
      if (content) {
        if (model !== LLM_EXTRACTION.MODEL) {
          mcpLog('warning', `${operationLabel} succeeded with fallback model ${model}`, 'llm');
        }
        return { content, model };
      }

      lastError = `Empty response from model ${model}`;
      mcpLog('warning', `${operationLabel} returned empty content for model ${model}`, 'llm');
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      mcpLog('warning', `${operationLabel} failed for model ${model}: ${lastError}`, 'llm');
    }
  }

  return { content: null, model: LLM_EXTRACTION.FALLBACK_MODEL, error: lastError };
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
  if (!config.enabled) {
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

  // Sanitize URL before sending to LLM: drop query string and fragment
  // so signed URLs, session tokens, auth params, or tracking hashes never
  // land in a third-party LLM prompt. Keep origin + path for page-type classification.
  const safeUrl = (() => {
    if (!config.url) return undefined;
    try {
      const u = new URL(config.url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return undefined;
    }
  })();
  const urlLine = safeUrl ? `PAGE URL: ${safeUrl}\n\n` : '';

  const prompt = config.extract
    ? `You are a factual extractor for a research agent. Extract ONLY the information that matches the instruction below. Do not summarize, interpret, or editorialize.

${urlLine}EXTRACTION INSTRUCTION: ${config.extract}

STEP 1 — Classify this page. Look at the URL if present, plus structural cues (code blocks, table patterns, comment threads, marketing copy). Pick ONE:
\`docs | changelog | github-readme | github-thread | reddit | hackernews | forum | blog | marketing | announcement | qa | cve | paper | release-notes | other\`

STEP 2 — Adjust emphasis by page type:
- docs / changelog / github-readme / release-notes → API signatures, version numbers, flags, exact config keys, code blocks. Copy verbatim. Preserve tables as tables.
- github-thread → weight MAINTAINER comments (label "[maintainer]") over drive-by commenters. Preserve stacktraces verbatim. Capture chronological resolution — what was decided and when. Link the accepted-fix commit/PR if referenced.
- reddit / hackernews / forum → lived experience. Quote verbatim with attribution ("u/foo wrote: …" or "user <name>"). Prioritize replies with stack details, specific failure stories, or replies that contradict the OP. Record overall sentiment distribution as one bullet if clear skew ("~70% agree / ~20% dissent / rest off-topic"). Drop context-free opinions ("this sucks") from Matches.
- blog → prioritize concrete reproductions, code, measurements. If the author makes a claim without evidence, mark "[unsourced claim]".
- marketing / announcement → pricing tiers, feature matrices verbatim, free-tier quotas, enterprise contact. Preserve tables as tables. Treat roadmap/future-tense claims skeptically — note them as "[announced, not shipped]" when framing is future-tense.
- qa (stackoverflow) → accepted answer's code + high-voted disagreements. Always note the answer date — SO rots.
- cve → CVSS vector verbatim, CWE, CPE ranges, affected versions, fix version, references. Each with its label.
- paper → claim, method, dataset, benchmark numbers, comparison baseline. Preserve numeric deltas verbatim.

STEP 3 — Emit markdown with these sections, in order:

## Source
- URL: <verbatim if visible, else "unknown">
- Page type: <the type you picked>
- Page date: <verbatim if visible, else "not visible">
- Author / maintainer (if identifiable): <verbatim>

## Matches
One bullet per distinct piece of matching info:
- **<short label>** — the information. Quote VERBATIM for: numbers, versions, dates, API names, prices, error messages, stacktraces, CVSS vectors, benchmark scores, command flags, proper nouns, and people's words. Backticks for code/identifiers. Preserve tables.

## Not found
Every part of the extraction instruction this page did NOT answer. Be explicit. Example: "Enterprise pricing contact — not present on this page."

## Follow-up signals
Short bullets — NEW angles this page surfaced that the agent should investigate. Include: new terms, unexpected vendor names, contradicting claims, referenced-but-unscraped URLs. Copy URLs VERBATIM from the source; if only anchor text is visible, write "anchor: <text> (URL not in scraped content)". Skip this section if nothing new surfaced. Do NOT invent.

## Contradictions
(Include this section only if the page contains internally contradictory claims.) Bullet each contradiction with both sides quoted verbatim.

## Truncation
(Include only if content appears cut mid-element.) "Content cut mid-<table row / code block / comment / paragraph>; extraction may be incomplete for <section>."

RULES:
- Never paraphrase numbers, versions, code, or quoted text.
- If an instruction item is not answered, it goes in "Not found" — do NOT invent an answer to please the caller.
- Preserve code blocks, command examples, tables exactly.
- Do NOT add commentary or recommendations outside "Follow-up signals".
- Page language ≠ English: quote verbatim in the original language AND provide a parenthetical gloss in English.
- Content clearly failed to load: return ONLY a single line, choosing from:
  \`## Matches\\n_Page did not load: 404_\`
  \`## Matches\\n_Page did not load: login-wall_\`
  \`## Matches\\n_Page did not load: paywall_\`
  \`## Matches\\n_Page did not load: JS-render-empty_\`
  \`## Matches\\n_Page did not load: non-text-asset_\`
  \`## Matches\\n_Page did not load: truncated-before-relevant-section_\`

Content:
${truncatedContent}`
    : `Clean the following page content: drop navigation, ads, cookie banners, footers, author bios, related-article lists. Preserve headings, paragraphs, code blocks, tables, and inline links as \`[text](url)\`. Do NOT summarize — preserve the full body.

${urlLine}Content:
${truncatedContent}`;

  let lastError: StructuredError | undefined;

  // Retry loop
  for (let attempt = 0; attempt <= LLM_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      if (attempt === 0) {
        mcpLog('info', `Starting extraction with ${LLM_EXTRACTION.MODEL}`, 'llm');
      } else {
        mcpLog('warning', `Retry attempt ${attempt}/${LLM_RETRY_CONFIG.maxRetries}`, 'llm');
      }

      const response = await requestTextWithFallback(
        processor,
        prompt,
        config.max_tokens || LLM_EXTRACTION.MAX_TOKENS,
        'LLM extraction',
        signal,
      );

      if (response.content) {
        mcpLog('info', `Successfully extracted ${response.content.length} characters`, 'llm');
        return { content: response.content, processed: true };
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

// ============================================================================
// Web-Search Result Classification
// ============================================================================

/** Maximum URLs to send to the LLM for classification */
const MAX_CLASSIFICATION_URLS = 50 as const;

/** Classification tiers */
type ClassificationTier = 'HIGHLY_RELEVANT' | 'MAYBE_RELEVANT' | 'OTHER';

export interface ClassificationEntry {
  readonly rank: number;
  readonly tier: ClassificationTier;
  readonly source_type?: string;
  readonly reason?: string;
}

export interface ClassificationGap {
  readonly id: number;
  readonly description: string;
}

export interface ClassificationResult {
  readonly title: string;
  readonly synthesis: string;
  readonly results: ClassificationEntry[];
  readonly refine_queries?: Array<{
    readonly query: string;
    readonly rationale: string;
    readonly gap_id?: number;
  }>;
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly confidence_reason?: string;
  readonly gaps?: ClassificationGap[];
}

export interface RefineQuerySuggestion {
  readonly query: string;
  readonly rationale: string;
  readonly gap_id?: number;
  readonly gap_description?: string;
}

/**
 * Classify web-search results by relevance to an objective using the LLM.
 * Sends only titles, snippets, and domain names — does NOT fetch URLs.
 * Returns null on failure (caller should fall back to raw output).
 */
export async function classifySearchResults(
  rankedUrls: ReadonlyArray<{
    readonly rank: number;
    readonly url: string;
    readonly title: string;
    readonly snippet: string;
    readonly frequency: number;
    readonly queries: string[];
  }>,
  objective: string,
  totalQueries: number,
  processor: OpenAI,
  previousQueries: readonly string[] = [],
): Promise<{ result: ClassificationResult | null; error?: string }> {
  const urlsToClassify = rankedUrls.slice(0, MAX_CLASSIFICATION_URLS);

  // Build compressed result list — title + domain + snippet (truncated)
  const lines: string[] = [];
  for (const url of urlsToClassify) {
    let domain: string;
    try {
      domain = new URL(url.url).hostname.replace(/^www\./, '');
    } catch {
      domain = url.url;
    }
    const snippet = url.snippet.length > 120
      ? url.snippet.slice(0, 117) + '...'
      : url.snippet;
    lines.push(`[${url.rank}] ${url.title} — ${domain} — ${snippet}`);
  }

  const prevQueriesBlock = previousQueries.length > 0
    ? previousQueries.map((q) => `- ${q}`).join('\n')
    : '- (none provided)';
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are the relevance filter for a research agent. Classify each search result below against the objective and produce a structured analysis.

OBJECTIVE: ${objective}
TODAY: ${today}

PREVIOUS QUERIES (already run — do NOT paraphrase in refine_queries):
${prevQueriesBlock}

Return ONLY a JSON object (no markdown, no code fences):

{
  "title": "2–8 word label for this RESULT CLUSTER (not the objective)",
  "synthesis": "3–5 sentences grounded in the results. Every non-trivial claim cites a rank in [brackets], e.g. '[3] documents the flag; [7][12] report it is broken on macOS.' A synthesis with zero citations is invalid.",
  "confidence": "high | medium | low",
  "confidence_reason": "one sentence — why",
  "gaps": [
    { "id": 0, "description": "specific, actionable thing the current results do NOT answer — not 'more info needed'" }
  ],
  "refine_queries": [
    { "query": "concrete next search", "gap_id": 0, "rationale": "≤12 words" }
  ],
  "results": [
    {
      "rank": 1,
      "tier": "HIGHLY_RELEVANT | MAYBE_RELEVANT | OTHER",
      "source_type": "vendor_doc | github | reddit | hackernews | blog | news | marketing | stackoverflow | cve | paper | release_notes | aggregator | other",
      "reason": "≤12 words citing the snippet cue that drove the tier"
    }
  ]
}

SOURCE-OF-TRUTH RUBRIC (the "primary source" is goal-dependent — infer goal type from the objective):
- spec / API / config questions → vendor_doc, github (README, RFC), release_notes are primary
- bug / failure-mode questions → github (issue/PR), stackoverflow are primary
- migration / sentiment / lived-experience → reddit, hackernews, blog are primary; docs are secondary
- pricing / commercial → marketing (the vendor's own pricing page IS the primary source, but treat feature lists skeptically)
- security / CVE → cve databases, distro security trackers (nvd.nist.gov, security-tracker.debian.org, ubuntu.com/security) are primary
- synthesis / open-ended → blend; no single type is primary
- product launch → vendor_doc + news + marketing for the launch itself; blogs + reddit for independent verification

FRESHNESS: proportional to topic velocity. For a week-old release, demote anything older than 30 days. For general tech questions, demote older than 18 months. For stable protocols (HTTP, TCP, POSIX), don't demote by age.

CONFIDENCE:
- high = ≥3 HIGHLY_RELEVANT results from INDEPENDENT domains agree on the core answer
- medium = ≥2 HIGHLY_RELEVANT exist but disagree or share a domain; OR a single authoritative primary source answers it
- low = otherwise; snippet-only judgments cap at medium

REFINE QUERIES — each MUST differ from every previousQuery by:
- a new operator (site:, quotes, verbatim version number), OR
- a domain-specific noun ABSENT from every prior query
Adding a year alone does NOT count as differentiation.
Each refine_query MUST reference a specific gap_id from the gaps array above.
Produce 4–8 refine_queries total. Cover: (a) a primary-source probe, (b) a temporal sharpener, (c) a failure-mode or comparison probe, (d) at least one new-term probe seeded by a specific result's snippet.

RULES:
- Classify ALL ${urlsToClassify.length} results. Do not skip or collapse any.
- Use only the three tier values.
- Judge from title + domain + snippet only. Do NOT invent facts not present in the snippet.
- If ALL results are OTHER: synthesis = "", confidence = "low", and \`gaps\` must explicitly state why the current queries missed the target.
- Casing: tier = UPPERCASE_WITH_UNDERSCORES, confidence = lowercase.

SEARCH RESULTS (${urlsToClassify.length} URLs from ${totalQueries} queries):
${lines.join('\n')}`;

  try {
    mcpLog('info', `Classifying ${urlsToClassify.length} URLs against objective`, 'llm');

    // Output budget needs room for: 50 results × (rank + tier + source_type + reason)
    // plus gaps[] with descriptions, refine_queries[] with rationales, synthesis with citations,
    // title, confidence, and confidence_reason. 4000 truncates JSON mid-structure for full outputs;
    // 8000 leaves headroom for the richest cases.
    const response = await requestTextWithFallback(
      processor,
      prompt,
      8000,
      'Search classification',
    );

    if (!response.content) {
      return { result: null, error: response.error ?? 'LLM returned empty classification response' };
    }

    // Strip markdown code fences if present
    const cleaned = response.content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as ClassificationResult;

    // Validate the response shape.
    // Note: synthesis is typed not truthy — the prompt explicitly instructs an empty string
    // for the all-OTHER case, and we must not reject that.
    if (!parsed.title || typeof parsed.synthesis !== 'string' || !Array.isArray(parsed.results)) {
      return { result: null, error: 'LLM response missing required fields (title, synthesis, results)' };
    }

    mcpLog('info', `Classification complete: ${parsed.results.filter(r => r.tier === 'HIGHLY_RELEVANT').length} highly relevant`, 'llm');
    return { result: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('error', `Classification failed: ${message}`, 'llm');
    return { result: null, error: `Classification failed: ${message}` };
  }
}

export async function suggestRefineQueriesForRawMode(
  rankedUrls: ReadonlyArray<{
    readonly rank: number;
    readonly url: string;
    readonly title: string;
  }>,
  objective: string,
  originalQueries: readonly string[],
  processor: OpenAI,
): Promise<{ result: RefineQuerySuggestion[]; error?: string }> {
  const urlsToSummarize = rankedUrls.slice(0, 12);
  const lines = urlsToSummarize.map((url) => {
    let domain: string;
    try {
      domain = new URL(url.url).hostname.replace(/^www\./, '');
    } catch {
      domain = url.url;
    }
    return `[${url.rank}] ${url.title} — ${domain}`;
  });

  const prompt = `You are generating follow-up search queries for an agent using raw web-search results.

Return ONLY a JSON object (no markdown, no code fences):
{
  "refine_queries": [
    { "query": "next search query", "gap_description": "what gap this closes", "rationale": "≤12 words on why" }
  ]
}

OBJECTIVE: ${objective}

PREVIOUS QUERIES (already run — do NOT paraphrase):
${originalQueries.map((query) => `- ${query}`).join('\n')}

TOP RESULT TITLES (to seed new-term probes):
${lines.join('\n')}

RULES:
- Produce 4–6 diverse follow-ups. Cover: (a) a primary-source probe (site:, RFC, vendor docs); (b) a temporal sharpener (changelog, version number); (c) a failure-mode or comparison probe; (d) at least one new-term probe seeded by a specific result title.
- Each query MUST differ from every previousQuery by either a new operator (site:, quotes, a verbatim version number) OR a domain-specific noun absent from every prior query. Adding a year alone does NOT count.
- Each refine_query MUST include a \`gap_description\` naming what the current results don't answer.
- Do not include URLs.
- Keep rationales ≤12 words.`;

  try {
    const response = await requestTextWithFallback(
      processor,
      prompt,
      800,
      'Raw-mode refine query generation',
    );

    if (!response.content) {
      return { result: [], error: response.error ?? 'LLM returned empty raw-mode refine query response' };
    }

    const cleaned = response.content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as { refine_queries?: RefineQuerySuggestion[] };

    return { result: Array.isArray(parsed.refine_queries) ? parsed.refine_queries : [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('error', `Raw-mode refine query generation failed: ${message}`, 'llm');
    return { result: [], error: message };
  }
}

// ============================================================================
// Research Brief — goal-aware orientation (called by start-research)
// ============================================================================

export interface ResearchBriefConceptGroup {
  readonly facet: string;
  readonly queries: readonly string[];
}

export interface ResearchBrief {
  readonly goal_class: string;
  readonly goal_class_reason: string;
  readonly source_priority: readonly string[];
  readonly sources_to_deprioritize: readonly string[];
  readonly fire_reddit_branch: boolean;
  readonly fire_reddit_reason: string;
  readonly freshness_window: string;
  readonly concept_groups: readonly ResearchBriefConceptGroup[];
  readonly anticipated_gaps: readonly string[];
  readonly first_scrape_targets: readonly string[];
  readonly success_criteria: readonly string[];
}

const VALID_GOAL_CLASSES = new Set([
  'spec', 'bug', 'migration', 'sentiment', 'pricing', 'security',
  'synthesis', 'product_launch', 'other',
]);

const VALID_FRESHNESS = new Set(['days', 'weeks', 'months', 'years']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isConceptGroupArray(value: unknown): value is ResearchBriefConceptGroup[] {
  return Array.isArray(value) && value.every((g) => {
    if (typeof g !== 'object' || g === null) return false;
    const facet = (g as Record<string, unknown>).facet;
    const queries = (g as Record<string, unknown>).queries;
    return typeof facet === 'string'
      && facet.trim().length > 0
      && isStringArray(queries)
      && queries.length > 0
      && queries.every((q) => q.trim().length > 0);
  });
}

export function parseResearchBrief(raw: string): ResearchBrief | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const goal_class = typeof parsed.goal_class === 'string' ? parsed.goal_class : null;
    if (!goal_class || !VALID_GOAL_CLASSES.has(goal_class)) return null;

    const freshness_window = typeof parsed.freshness_window === 'string' ? parsed.freshness_window : null;
    if (!freshness_window || !VALID_FRESHNESS.has(freshness_window)) return null;

    if (typeof parsed.fire_reddit_branch !== 'boolean') return null;
    if (!isConceptGroupArray(parsed.concept_groups) || parsed.concept_groups.length === 0) return null;

    return {
      goal_class,
      goal_class_reason: typeof parsed.goal_class_reason === 'string' ? parsed.goal_class_reason : '',
      source_priority: isStringArray(parsed.source_priority) ? parsed.source_priority : [],
      sources_to_deprioritize: isStringArray(parsed.sources_to_deprioritize) ? parsed.sources_to_deprioritize : [],
      fire_reddit_branch: parsed.fire_reddit_branch,
      fire_reddit_reason: typeof parsed.fire_reddit_reason === 'string' ? parsed.fire_reddit_reason : '',
      freshness_window,
      concept_groups: parsed.concept_groups,
      anticipated_gaps: isStringArray(parsed.anticipated_gaps) ? parsed.anticipated_gaps : [],
      first_scrape_targets: isStringArray(parsed.first_scrape_targets) ? parsed.first_scrape_targets : [],
      success_criteria: isStringArray(parsed.success_criteria) ? parsed.success_criteria : [],
    };
  } catch {
    return null;
  }
}

export async function generateResearchBrief(
  goal: string,
  processor: OpenAI,
  signal?: AbortSignal,
): Promise<ResearchBrief | null> {
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are a research planner. An agent is about to run a multi-pass research loop on the goal below. Produce a tailored research brief in JSON.

GOAL: ${goal}
TODAY: ${today}

Return ONLY a JSON object (no markdown, no code fences):

{
  "goal_class": "spec | bug | migration | sentiment | pricing | security | synthesis | product_launch | other",
  "goal_class_reason": "one sentence — why this class",
  "source_priority": ["ordered list from: vendor_docs, changelog, github_code, github_issues, reddit, hackernews, blogs, marketing_pages, stackoverflow, cve_databases, arxiv, news, release_notes"],
  "sources_to_deprioritize": ["same vocabulary — sources that add noise for this goal"],
  "fire_reddit_branch": true,
  "fire_reddit_reason": "one sentence — why yes or why no",
  "freshness_window": "days | weeks | months | years",
  "concept_groups": [
    {
      "facet": "2-4 word facet name",
      "queries": ["5-10 concrete Google queries using operators where helpful: site:, quotes, version numbers"]
    }
  ],
  "anticipated_gaps": ["2-5 things likely missing after pass 1 that the agent should watch for"],
  "first_scrape_targets": ["domain names or URL patterns most likely to contain the answer"],
  "success_criteria": ["2-4 concrete facts the agent must verify before declaring done"]
}

Rules:
- Concept groups must probe DIFFERENT facets. Same noun-phrase cannot repeat across groups.
- Queries within a group vary by operator/phrasing but probe the same facet.
- Total queries across all groups: 25–50. Narrow bugs fewer; open synthesis more.
- If the goal mentions a recent release / date / version, freshness_window = days or weeks.
- Do NOT invent vendor names you are uncertain exist. Leave shaky queries out.
- source_priority MUST reflect the goal type — docs for spec, github_issues for bugs, reddit/hackernews/blogs for migration/sentiment, cve_databases for security.
- fire_reddit_branch should be false for CVE / pricing / API spec / primary-source lookups.`;

  try {
    const response = await requestTextWithFallback(
      processor,
      prompt,
      2500,
      'Research brief generation',
      signal,
    );

    if (!response.content) {
      mcpLog('warning', `Research brief generation returned no content: ${response.error ?? 'unknown'}`, 'llm');
      return null;
    }

    const brief = parseResearchBrief(response.content);
    if (!brief) {
      mcpLog('warning', 'Research brief JSON parse or shape validation failed', 'llm');
      return null;
    }

    return brief;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('warning', `Research brief generation failed: ${message}`, 'llm');
    return null;
  }
}

export function renderResearchBrief(brief: ResearchBrief): string {
  const lines: string[] = [];

  lines.push('## Your research brief (goal-tailored)');
  lines.push('');
  lines.push(`**Goal class**: \`${brief.goal_class}\` — ${brief.goal_class_reason}`);
  lines.push(`**Freshness target**: \`${brief.freshness_window}\``);
  lines.push(`**Reddit branch**: ${brief.fire_reddit_branch ? '**fire**' : 'skip'} — ${brief.fire_reddit_reason}`);
  lines.push('');

  if (brief.source_priority.length > 0) {
    lines.push('**Source priority** (highest → lowest):');
    brief.source_priority.forEach((src, i) => lines.push(`${i + 1}. \`${src}\``));
    lines.push('');
  }

  if (brief.sources_to_deprioritize.length > 0) {
    lines.push(`**Deprioritize**: ${brief.sources_to_deprioritize.map((s) => `\`${s}\``).join(', ')}`);
    lines.push('');
  }

  lines.push('### Pass 1 concept groups');
  lines.push('');
  lines.push('Issue every query below in ONE `web-search` call (flat array).');
  lines.push('');

  for (const group of brief.concept_groups) {
    lines.push(`#### ${group.facet}`);
    for (const query of group.queries) {
      lines.push(`- ${query}`);
    }
    lines.push('');
  }

  if (brief.anticipated_gaps.length > 0) {
    lines.push('### Anticipated gaps (watch the classifier\'s `gaps[]` output for these)');
    brief.anticipated_gaps.forEach((g) => lines.push(`- ${g}`));
    lines.push('');
  }

  if (brief.first_scrape_targets.length > 0) {
    lines.push('### First-pass scrape targets (prioritize these in `scrape-links`)');
    brief.first_scrape_targets.forEach((t) => lines.push(`- ${t}`));
    lines.push('');
  }

  if (brief.success_criteria.length > 0) {
    lines.push('### Success criteria (do not declare done until all are verified)');
    brief.success_criteria.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Run all concept-group queries above in ONE `web-search` call, then loop per the discipline above.');

  return lines.join('\n');
}
