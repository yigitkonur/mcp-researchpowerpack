import type { MCPServer } from 'mcp-use/server';

import {
  startResearchOutputSchema,
  startResearchParamsSchema,
  type StartResearchOutput,
  type StartResearchParams,
} from '../schemas/start-research.js';
import {
  createLLMProcessor,
  generateResearchBrief,
  getLLMHealth,
  renderResearchBrief,
  type LLMHealthSnapshot,
} from '../services/llm-processor.js';
import { classifyError } from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';
import { toolFailure, toolSuccess, toToolResponse, type ToolExecutionResult } from './mcp-helpers.js';
import { formatError } from './utils.js';

const SKILL_INSTALL_HINT = [
  '> 💡 **Pair this server with the `run-research` skill** for the full agentic playbook',
  '> (single-agent loop, multi-agent orchestrator, mission-prompt templates, output discipline).',
  '> Install once per machine — the skill is what teaches the agent how to spend these tools well:',
  '>',
  '> ```bash',
  '> npx -y skills add -y -g yigitkonur/skills-by-yigitkonur/skills/run-research',
  '> ```',
  '>',
  '> Already installed? Skip this — the skill auto-loads on relevant prompts. The full pack',
  '> ships ~50 sibling skills: `npx -y skills add -y -g yigitkonur/skills-by-yigitkonur`.',
].join('\n');

/**
 * Full research-loop playbook. Teaches the 3-tool mental model
 * (start-research, web-search, scrape-links), the aggressive multi-call
 * discipline, parallel-callability, and the cite-from-scrape rule.
 *
 * Emitted when the LLM planner is healthy OR `include_playbook: true`.
 */
export function buildStaticScaffolding(goal?: string, opts: { plannerAvailable?: boolean } = {}): string {
  const plannerAvailable = opts.plannerAvailable ?? true;
  const focusLine = goal
    ? `> Focus for this session: ${goal}`
    : '> Focus for this session: not yet specified — set one on the next pass';

  const classifierLoopStep = plannerAvailable
    ? '3. Read the classifier output: `synthesis` (citations in `[rank]`), `gaps[]` (with ids), `refine_queries[]` (follow-ups tied to gap ids).'
    : '3. Classifier output is NOT available (LLM planner offline). `web-search` returns a raw ranked list — synthesize the terrain yourself from titles + snippets.';

  return [
    '# Research session started',
    '',
    SKILL_INSTALL_HINT,
    '',
    focusLine,
    '',
    'You are running a research LOOP, not answering from memory. Training data is stale; the web is authoritative for anything dated, versioned, priced, or contested. Every non-trivial claim in your final answer must be traceable to a `scrape-links` excerpt you read. Never cite a URL from a `web-search` snippet alone.',
    '',
    '## The 3 tools',
    '',
    '**1. `start-research`** — you just called me. I plan this session and return the brief below. Call me again only if the goal materially shifts.',
    '',
    '**2. `web-search`** — fan out Google queries in parallel. One call carries **up to 50 queries** in a flat `queries` array. Call me **aggressively** — 2–4 rounds per session is normal, not 1. After each pass, read `gaps[]` and `refine_queries[]` and fire another round with the harvested terms. **Parallel-safe**: run multiple `web-search` calls in the same turn for orthogonal subtopics (e.g. one call for "spec" queries, one call for "sentiment" queries). `scope` values:',
    '- `"reddit"` → server appends `site:reddit.com` and filters to post permalinks. Use for sentiment / migration / lived experience.',
    '- `"web"` (default) → open web. Use for spec / bug / pricing / CVE / API / primary-source hunts.',
    '- `"both"` → fans each query across both. Use when the topic is opinion-heavy AND needs official sources.',
    '',
    '**3. `scrape-links`** — fetch URLs in parallel and run per-URL LLM extraction. **Auto-detects** `reddit.com/r/.../comments/` permalinks and routes them through the Reddit API (threaded post + comments); everything else flows through the HTTP scraper. Mix Reddit + web URLs freely — both branches run concurrently. **Parallel-safe**: prefer multiple `scrape-links` calls with contextually grouped URLs over one giant mixed batch. Each page returns `## Source`, `## Matches` (verbatim facts), `## Not found` (explicit gaps this page did NOT answer), `## Follow-up signals` (new terms + referenced-but-unscraped URLs that seed your next `web-search` round). Describe extraction SHAPE in `extract`, facets separated by `|`: `root cause | affected versions | fix | workarounds | timeline`.',
    '',
    '## The loop',
    '',
    '1. Read the brief below (if present). Note `primary_branch`, `keyword_seeds`, `gaps_to_watch`, `stop_criteria`.',
    '2. Fire `first_call_sequence` in order. For `primary_branch: reddit`, lead with `web-search scope:"reddit"` → `scrape-links` on the best post permalinks. For `web`, lead with `web-search scope:"web"` → `scrape-links` on HIGHLY_RELEVANT URLs. For `both`, issue two parallel `web-search` calls (one per scope) in the same turn, then one merged `scrape-links`.',
    classifierLoopStep,
    '4. Scrape every HIGHLY_RELEVANT plus the 2–3 best MAYBE_RELEVANT. Group URLs into parallel `scrape-links` calls when contexts differ (e.g. one call for docs, one for reddit threads).',
    '5. Harvest from each scrape extract\'s `## Follow-up signals` — new terms, version numbers, vendor names, failure modes, referenced URLs. These seed your next `web-search` round.',
    '6. Fire the next `web-search` round with the harvested terms plus any `refine_queries[]` the classifier suggested. Do NOT paraphrase queries already run — the classifier tracks them.',
    '7. **Stop** when every `gaps_to_watch` item is closed AND the last `web-search` pass surfaced no new terms, OR when you have completed 4 full passes. State remaining gaps explicitly if you hit the cap.',
    '',
    '## Output discipline',
    '',
    '- Cite URL (or Reddit permalink) for every non-trivial claim — only from a `scrape-links` excerpt you read.',
    '- Quote verbatim: numbers, versions, API names, prices, error messages, stacktraces, people\'s words.',
    '- Separate documented facts from inferred conclusions explicitly.',
    '- Include the scrape date for time-sensitive claims.',
    '- If you could not verify something, say so — do not paper over gaps.',
    '- Never cite a URL from a search snippet alone.',
    '',
    '## Post-cutoff discipline',
    '',
    'For anything released / changed after your training cutoff — new products, versions, prices, benchmarks — treat your own query suggestions as hypotheses until a scraped first-party page confirms them. Include `site:<vendor-domain>` queries in your first `web-search` call when the goal names a vendor or product.',
  ].join('\n');
}

/**
 * Compact stub emitted when the LLM planner is offline AND the caller did
 * not opt into the full playbook. Names the 3 tools, the loop, parallel-safety,
 * Reddit branch, and cite-from-scrape — enough to keep an agent moving.
 */
export function buildDegradedStub(goal?: string): string {
  const focusLine = goal
    ? `> Focus for this session: ${goal}`
    : '> Focus for this session: not specified — set one on the next pass.';
  return [
    '# Research session started (LLM planner offline — compact stub)',
    '',
    SKILL_INSTALL_HINT,
    '',
    focusLine,
    '',
    '**3 tools**: `start-research` (plans), `web-search` (Google fan-out, up to 50 queries/call, `scope: web|reddit|both`), `scrape-links` (fetch URLs in parallel, auto-detects `reddit.com/r/.../comments/` permalinks → Reddit API; all other URLs → HTTP scraper). All three are **parallel-callable** — fire multiple in the same turn when subtopics are orthogonal.',
    '',
    '**Loop**: `web-search` → `scrape-links` → read `## Follow-up signals` → harvest new terms → next `web-search` round → stop when gaps close OR after 4 passes. Call `web-search` aggressively (2–4 rounds, not 1).',
    '',
    '**Reddit branch**: use `web-search scope:"reddit"` for sentiment / migration / lived experience. Skip for CVE / API spec / pricing. Reddit permalinks go straight into `scrape-links` for threaded post + comments.',
    '',
    '**Cite**: every non-trivial claim must trace to a `scrape-links` excerpt, never a search snippet. Quote verbatim for numbers, versions, stacktraces, people\'s words.',
    '',
    'Pass `include_playbook: true` to `start-research` for the full tactic reference.',
  ].join('\n');
}

/**
 * Backward-compat alias — older call sites import `buildOrientation` directly.
 */
export const buildOrientation = buildStaticScaffolding;

// ============================================================================
// Planner-offline gate.
//
// The problem we are guarding against: a single transient LLM failure (one bad
// 429, one malformed JSON response from the classifier) used to poison the
// gate forever and force every subsequent `start-research` call into the
// compact stub — even when env was fine and the next call would have
// succeeded. That created a deadlock where the very tool that could reset
// the health flag was the tool being blocked.
//
// The safer semantics implemented here:
//  1. If env is not configured, we are offline. Hard stop.
//  2. Otherwise, require **two consecutive failures** before gating (one
//     blip is tolerated).
//  3. Even then, the gate only holds for PLANNER_FAILURE_TTL_MS after the
//     most recent failure. After that window we give the planner another
//     chance regardless of the counter — if it is still broken the next
//     call's failure will re-arm the gate.
//  4. Any success resets the counter to 0, so the gate opens immediately
//     on recovery.
// ============================================================================

/** Minimum consecutive failures before the gate closes. */
export const PLANNER_FAILURE_THRESHOLD = 2;

/** How long a recent failure burst keeps the gate closed, in ms. */
export const PLANNER_FAILURE_TTL_MS = 60_000;

type PlannerGateHealth = Pick<
  LLMHealthSnapshot,
  'plannerConfigured' | 'consecutivePlannerFailures' | 'lastPlannerCheckedAt'
>;

/**
 * Pure predicate — returns true when the planner should be treated as
 * offline for the purposes of `start-research`. Kept exported and
 * dependency-free so tests can drive it without touching the LLM.
 */
export function isPlannerKnownOffline(
  health: PlannerGateHealth,
  nowMs: number = Date.now(),
): boolean {
  if (!health.plannerConfigured) {
    return true;
  }
  if (health.consecutivePlannerFailures < PLANNER_FAILURE_THRESHOLD) {
    return false;
  }
  if (health.lastPlannerCheckedAt === null) {
    return false;
  }
  const lastMs = Date.parse(health.lastPlannerCheckedAt);
  if (Number.isNaN(lastMs)) {
    return false;
  }
  return nowMs - lastMs < PLANNER_FAILURE_TTL_MS;
}

async function buildGoalAwareBrief(
  goal: string,
  signal?: AbortSignal,
): Promise<string> {
  const processor = createLLMProcessor();
  if (!processor) {
    mcpLog('info', 'start-research: LLM unavailable, returning static orientation only', 'start-research');
    return '';
  }

  const brief = await generateResearchBrief(goal, processor, signal);
  if (!brief) {
    mcpLog('warning', 'start-research: brief generation failed, returning static orientation only', 'start-research');
    return '';
  }

  return renderResearchBrief(brief);
}

async function handleStartResearch(
  params: StartResearchParams,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<StartResearchOutput>> {
  try {
    const llmHealth = getLLMHealth();
    const plannerKnownOffline = isPlannerKnownOffline(llmHealth);

    if (plannerKnownOffline && !params.include_playbook) {
      const stub = buildDegradedStub(params.goal);
      return toolSuccess(stub);
    }

    const scaffolding = buildStaticScaffolding(params.goal, {
      plannerAvailable: !plannerKnownOffline,
    });

    let brief = '';
    if (params.goal) {
      brief = await buildGoalAwareBrief(params.goal, signal);
    }

    const briefFallbackNote = params.goal && !brief
      ? '\n\n---\n\n> _Goal-tailored brief unavailable: LLM planner is not configured or failed this call. The static playbook above still applies; you can proceed with it, or retry `start-research` after verifying `LLM_API_KEY`._'
      : '';

    const content = brief
      ? `${scaffolding}\n\n---\n\n${brief}`
      : `${scaffolding}${briefFallbackNote}`;

    return toolSuccess(content);
  } catch (err: unknown) {
    const structuredError = classifyError(err);
    mcpLog('error', `start-research: ${structuredError.message}`, 'start-research');
    return toolFailure(
      formatError({
        code: structuredError.code,
        message: structuredError.message,
        retryable: structuredError.retryable,
        toolName: 'start-research',
        howToFix: ['Retry start-research. If the failure persists, verify LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.'],
      }),
    );
  }
}

export function registerStartResearchTool(server: MCPServer): void {
  server.tool(
    {
      name: 'start-research',
      title: 'Start Research Session',
      description:
        'Call this FIRST every research session. Provide a `goal`; I return a goal-tailored brief naming (a) `primary_branch` (reddit for sentiment/migration, web for spec/bug/pricing, both when opinion-heavy AND needs official sources), (b) the exact `first_call_sequence` of web-search + scrape-links calls to fire, (c) 25–50 keyword seeds for your first `web-search` call, (d) iteration hints, (e) gaps to watch, (f) stop criteria. No goal? You still get the generic 3-tool playbook. Other tools work without calling this, but you will use them worse.',
      schema: startResearchParamsSchema,
      outputSchema: startResearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => toToolResponse(await handleStartResearch(args)),
  );
}
