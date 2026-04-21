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

// ============================================================================
// LLM health tracking — surfaced via health://status so capability-aware
// clients can branch on degraded mode without parsing per-call footers.
// ============================================================================

type LLMHealthKind = 'planner' | 'extractor';

export interface LLMHealthSnapshot {
  readonly lastPlannerOk: boolean;
  readonly lastExtractorOk: boolean;
  readonly lastPlannerCheckedAt: string | null;
  readonly lastExtractorCheckedAt: string | null;
  readonly lastPlannerError: string | null;
  readonly lastExtractorError: string | null;
  readonly plannerConfigured: boolean;
  readonly extractorConfigured: boolean;
  /** Failures since the last success. Reset to 0 on `markLLMSuccess`. */
  readonly consecutivePlannerFailures: number;
  readonly consecutiveExtractorFailures: number;
}

const llmHealth = {
  lastPlannerOk: false,
  lastExtractorOk: false,
  lastPlannerCheckedAt: null as string | null,
  lastExtractorCheckedAt: null as string | null,
  lastPlannerError: null as string | null,
  lastExtractorError: null as string | null,
  consecutivePlannerFailures: 0,
  consecutiveExtractorFailures: 0,
};

export function markLLMSuccess(kind: LLMHealthKind): void {
  const ts = new Date().toISOString();
  if (kind === 'planner') {
    llmHealth.lastPlannerOk = true;
    llmHealth.lastPlannerCheckedAt = ts;
    llmHealth.lastPlannerError = null;
    llmHealth.consecutivePlannerFailures = 0;
  } else {
    llmHealth.lastExtractorOk = true;
    llmHealth.lastExtractorCheckedAt = ts;
    llmHealth.lastExtractorError = null;
    llmHealth.consecutiveExtractorFailures = 0;
  }
}

export function markLLMFailure(kind: LLMHealthKind, err: unknown): void {
  const ts = new Date().toISOString();
  const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
  if (kind === 'planner') {
    llmHealth.lastPlannerOk = false;
    llmHealth.lastPlannerCheckedAt = ts;
    llmHealth.lastPlannerError = message;
    llmHealth.consecutivePlannerFailures += 1;
  } else {
    llmHealth.lastExtractorOk = false;
    llmHealth.lastExtractorCheckedAt = ts;
    llmHealth.lastExtractorError = message;
    llmHealth.consecutiveExtractorFailures += 1;
  }
}

export function getLLMHealth(): LLMHealthSnapshot {
  const cap = getCapabilities();
  return {
    lastPlannerOk: llmHealth.lastPlannerOk,
    lastExtractorOk: llmHealth.lastExtractorOk,
    lastPlannerCheckedAt: llmHealth.lastPlannerCheckedAt,
    lastExtractorCheckedAt: llmHealth.lastExtractorCheckedAt,
    lastPlannerError: llmHealth.lastPlannerError,
    lastExtractorError: llmHealth.lastExtractorError,
    // Static capability — based on env presence at boot. Runtime health (above)
    // tells whether the last attempt actually succeeded.
    plannerConfigured: cap.llmExtraction,
    extractorConfigured: cap.llmExtraction,
    consecutivePlannerFailures: llmHealth.consecutivePlannerFailures,
    consecutiveExtractorFailures: llmHealth.consecutiveExtractorFailures,
  };
}

/** Test-only — reset state between tests. Not exported from index. */
export function _resetLLMHealthForTests(): void {
  llmHealth.lastPlannerOk = false;
  llmHealth.lastExtractorOk = false;
  llmHealth.lastPlannerCheckedAt = null;
  llmHealth.lastExtractorCheckedAt = null;
  llmHealth.lastPlannerError = null;
  llmHealth.lastExtractorError = null;
  llmHealth.consecutivePlannerFailures = 0;
  llmHealth.consecutiveExtractorFailures = 0;
}

interface ProcessingConfig {
  readonly enabled: boolean;
  readonly extract: string | undefined;
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

function buildChatRequestBody(model: string, prompt: string): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
  };

  if (LLM_EXTRACTION.REASONING_EFFORT !== 'none') {
    requestBody.reasoning_effort = LLM_EXTRACTION.REASONING_EFFORT;
  }

  return requestBody;
}

export async function requestText(
  processor: OpenAITextGenerator,
  prompt: string,
  operationLabel: string,
  signal?: AbortSignal,
): Promise<{ content: string | null; model: string; error?: string }> {
  const model = LLM_EXTRACTION.MODEL;

  try {
    const response = await withStallProtection(
      (stallSignal) => processor.chat.completions.create(
        buildChatRequestBody(model, prompt) as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
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
      return { content, model };
    }

    const err = `Empty response from model ${model}`;
    mcpLog('warning', `${operationLabel} returned empty content for model ${model}`, 'llm');
    return { content: null, model, error: err };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('warning', `${operationLabel} failed for model ${model}: ${message}`, 'llm');
    return { content: null, model, error: message };
  }
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

      const response = await requestText(
        processor,
        prompt,
        'LLM extraction',
        signal,
      );

      if (response.content) {
        mcpLog('info', `Successfully extracted ${response.content.length} characters`, 'llm');
        markLLMSuccess('extractor');
        return { content: response.content, processed: true };
      }

      // Empty response - not retryable
      mcpLog('warning', 'Received empty response from LLM', 'llm');
      markLLMFailure('extractor', 'LLM returned empty response');
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
  markLLMFailure('extractor', errorMessage);

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

  // Descending static weights fed to the LLM. Higher-ranked URLs get a bigger
  // weight so the classifier biases HIGHLY_RELEVANT toward them. The weights
  // here are a shown-to-LLM summary, not the internal CTR ranking (which
  // still runs in url-aggregator.ts). Rank 11+ all bucket to w=1.
  const STATIC_WEIGHTS = [30, 20, 15, 10, 8, 6, 5, 4, 3, 2] as const;
  const weightForRank = (rank: number): number => STATIC_WEIGHTS[rank - 1] ?? 1;

  // Build compressed result list — weight + title + domain + snippet (truncated)
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
    lines.push(`[${url.rank}] w=${weightForRank(url.rank)} ${url.title} — ${domain} — ${snippet}`);
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

WEIGHT SCHEME: each row is prefixed with a weight (w=N). Higher weight means the URL ranked better across input queries — prefer HIGHLY_RELEVANT for high-weight rows when content matches the objective. Weight alone never justifies HIGHLY_RELEVANT; snippet cues still drive the decision.

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

    const response = await requestText(
      processor,
      prompt,
      'Search classification',
    );

    if (!response.content) {
      const errMsg = response.error ?? 'LLM returned empty classification response';
      markLLMFailure('planner', errMsg);
      return { result: null, error: errMsg };
    }

    // Strip markdown code fences if present
    const cleaned = response.content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as ClassificationResult;

    // Validate the response shape.
    // Note: synthesis is typed not truthy — the prompt explicitly instructs an empty string
    // for the all-OTHER case, and we must not reject that.
    if (!parsed.title || typeof parsed.synthesis !== 'string' || !Array.isArray(parsed.results)) {
      const errMsg = 'LLM response missing required fields (title, synthesis, results)';
      markLLMFailure('planner', errMsg);
      return { result: null, error: errMsg };
    }

    mcpLog('info', `Classification complete: ${parsed.results.filter(r => r.tier === 'HIGHLY_RELEVANT').length} highly relevant`, 'llm');
    markLLMSuccess('planner');
    return { result: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('error', `Classification failed: ${message}`, 'llm');
    markLLMFailure('planner', message);
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
    const response = await requestText(
      processor,
      prompt,
      'Raw-mode refine query generation',
    );

    if (!response.content) {
      const errMsg = response.error ?? 'LLM returned empty raw-mode refine query response';
      markLLMFailure('planner', errMsg);
      return { result: [], error: errMsg };
    }

    const cleaned = response.content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as { refine_queries?: RefineQuerySuggestion[] };

    markLLMSuccess('planner');
    return { result: Array.isArray(parsed.refine_queries) ? parsed.refine_queries : [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('error', `Raw-mode refine query generation failed: ${message}`, 'llm');
    markLLMFailure('planner', message);
    return { result: [], error: message };
  }
}

// ============================================================================
// Research Brief — goal-aware orientation (called by start-research)
// ============================================================================

export type PrimaryBranch = 'reddit' | 'web' | 'both';

export interface ResearchBriefStep {
  readonly tool: 'web-search' | 'scrape-links';
  readonly reason: string;
}

export interface ResearchBrief {
  readonly goal_class: string;
  readonly goal_class_reason: string;
  readonly primary_branch: PrimaryBranch;
  readonly primary_branch_reason: string;
  readonly freshness_window: string;
  readonly first_call_sequence: readonly ResearchBriefStep[];
  readonly keyword_seeds: readonly string[];
  readonly iteration_hints: readonly string[];
  readonly gaps_to_watch: readonly string[];
  readonly stop_criteria: readonly string[];
}

const VALID_GOAL_CLASSES = new Set([
  'spec', 'bug', 'migration', 'sentiment', 'pricing', 'security',
  'synthesis', 'product_launch', 'other',
]);

const VALID_FRESHNESS = new Set(['days', 'weeks', 'months', 'years']);
const VALID_BRANCHES = new Set<PrimaryBranch>(['reddit', 'web', 'both']);
const VALID_STEP_TOOLS = new Set(['web-search', 'scrape-links']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStepArray(value: unknown): value is ResearchBriefStep[] {
  return Array.isArray(value) && value.every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const tool = (s as Record<string, unknown>).tool;
    const reason = (s as Record<string, unknown>).reason;
    return typeof tool === 'string'
      && VALID_STEP_TOOLS.has(tool)
      && typeof reason === 'string'
      && reason.trim().length > 0;
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

    const primary_branch = parsed.primary_branch;
    if (typeof primary_branch !== 'string' || !VALID_BRANCHES.has(primary_branch as PrimaryBranch)) return null;

    if (!isStepArray(parsed.first_call_sequence) || parsed.first_call_sequence.length === 0) return null;
    if (!isStringArray(parsed.keyword_seeds) || parsed.keyword_seeds.length === 0) return null;

    return {
      goal_class,
      goal_class_reason: typeof parsed.goal_class_reason === 'string' ? parsed.goal_class_reason : '',
      primary_branch: primary_branch as PrimaryBranch,
      primary_branch_reason: typeof parsed.primary_branch_reason === 'string' ? parsed.primary_branch_reason : '',
      freshness_window,
      first_call_sequence: parsed.first_call_sequence,
      keyword_seeds: parsed.keyword_seeds.filter((s) => s.trim().length > 0),
      iteration_hints: isStringArray(parsed.iteration_hints) ? parsed.iteration_hints : [],
      gaps_to_watch: isStringArray(parsed.gaps_to_watch) ? parsed.gaps_to_watch : [],
      stop_criteria: isStringArray(parsed.stop_criteria) ? parsed.stop_criteria : [],
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

  const prompt = `You are a research planner. An agent is about to run a multi-pass research loop on the goal below using 3 tools:

  - web-search: fan-out Google, scope: web|reddit|both, up to 50 queries per call, parallel-callable (multiple calls per turn)
  - scrape-links: fetch URLs in parallel, auto-detects reddit.com post permalinks → Reddit API (threaded post+comments); all other URLs → HTTP scraper; parallel-callable

Produce a tailored JSON brief.

GOAL: ${goal}
TODAY: ${today}

Return ONLY a JSON object (no markdown, no code fences):

{
  "goal_class": "spec | bug | migration | sentiment | pricing | security | synthesis | product_launch | other",
  "goal_class_reason": "one sentence — why this class",
  "primary_branch": "reddit | web | both",
  "primary_branch_reason": "one sentence — why this branch leads",
  "freshness_window": "days | weeks | months | years",
  "first_call_sequence": [
    { "tool": "web-search | scrape-links", "reason": "what this call establishes for the agent" }
  ],
  "keyword_seeds": ["25–50 concrete Google queries — flat list, to be fired in the first web-search call"],
  "iteration_hints": ["2–5 pointers on which harvested terms / follow-up signals to watch for after pass 1"],
  "gaps_to_watch": ["2–5 concrete questions the agent MUST verify or the answer is incomplete"],
  "stop_criteria": ["2–4 checkable conditions — all must hold before the agent declares done"]
}

RULES:

primary_branch:
- "reddit"  → sentiment / migration / lived-experience / community-consensus goals. Leads with scope:"reddit" web-search.
- "web"     → spec / bug / pricing / CVE / API / primary-source goals. Leads with scope:"web" web-search.
- "both"    → opinion-heavy AND needs official sources (e.g. product launch + practitioner reception).

first_call_sequence:
- 1–3 steps.
- reddit-first: step 1 = web-search (caller sets scope:"reddit"), step 2 = scrape-links on best post permalinks.
- web-first:    step 1 = web-search (scope:"web"), step 2 = scrape-links on HIGHLY_RELEVANT URLs.
- both:         step 1 = two parallel web-search calls (one scope:"reddit", one scope:"web"), step 2 = merged scrape-links.

keyword_seeds:
- 25–50 total. Narrow bug → fewer. Open synthesis → more.
- Use operators where helpful (site:, quotes, verbatim version numbers).
- DIVERSE facets — same noun-phrase cannot repeat across seeds with adjectives-only variation.
- Do NOT invent vendor names you are uncertain exist.

freshness_window:
- If the goal mentions a recent release / date / version, use "days" or "weeks".
- Stable protocols / APIs → "months" or "years".`;

  try {
    const response = await requestText(
      processor,
      prompt,
      'Research brief generation',
      signal,
    );

    if (!response.content) {
      mcpLog('warning', `Research brief generation returned no content: ${response.error ?? 'unknown'}`, 'llm');
      markLLMFailure('planner', response.error ?? 'empty response');
      return null;
    }

    const brief = parseResearchBrief(response.content);
    if (!brief) {
      mcpLog('warning', 'Research brief JSON parse or shape validation failed', 'llm');
      markLLMFailure('planner', 'brief parse/validation failed');
      return null;
    }

    markLLMSuccess('planner');
    return brief;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mcpLog('warning', `Research brief generation failed: ${message}`, 'llm');
    markLLMFailure('planner', message);
    return null;
  }
}

export function renderResearchBrief(brief: ResearchBrief): string {
  const lines: string[] = [];

  lines.push('## Your research brief (goal-tailored)');
  lines.push('');
  lines.push(`**Goal class**: \`${brief.goal_class}\` — ${brief.goal_class_reason}`);
  lines.push(`**Primary branch**: \`${brief.primary_branch}\` — ${brief.primary_branch_reason}`);
  lines.push(`**Freshness**: \`${brief.freshness_window}\``);
  lines.push('');

  if (brief.first_call_sequence.length > 0) {
    lines.push('### First-call sequence');
    brief.first_call_sequence.forEach((step, i) => {
      lines.push(`${i + 1}. \`${step.tool}\` — ${step.reason}`);
    });
    lines.push('');
  }

  if (brief.keyword_seeds.length > 0) {
    lines.push(`### Keyword seeds (${brief.keyword_seeds.length}) — fire these in your first \`web-search\` call as a flat \`queries\` array`);
    for (const seed of brief.keyword_seeds) {
      lines.push(`- ${seed}`);
    }
    lines.push('');
  }

  if (brief.iteration_hints.length > 0) {
    lines.push('### Iteration hints (harvest new terms from scrape extracts\' `## Follow-up signals`)');
    for (const hint of brief.iteration_hints) lines.push(`- ${hint}`);
    lines.push('');
  }

  if (brief.gaps_to_watch.length > 0) {
    lines.push('### Gaps to watch');
    for (const gap of brief.gaps_to_watch) lines.push(`- ${gap}`);
    lines.push('');
  }

  if (brief.stop_criteria.length > 0) {
    lines.push('### Stop criteria');
    for (const c of brief.stop_criteria) lines.push(`- ${c}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Fire `first_call_sequence` now. After each `scrape-links`, harvest new terms from `## Follow-up signals` and build your next `web-search` round. Stop when every gap is closed.');

  return lines.join('\n');
}
