import type { MCPServer } from 'mcp-use/server';

import {
  startResearchOutputSchema,
  startResearchParamsSchema,
  type StartResearchOutput,
  type StartResearchParams,
} from '../schemas/start-research.js';
import { getWorkflowStateStore } from '../services/workflow-state.js';
import {
  createLLMProcessor,
  generateResearchBrief,
  renderResearchBrief,
} from '../services/llm-processor.js';
import { buildWorkflowKey } from '../utils/workflow-key.js';
import { classifyError } from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';
import { toolFailure, toolSuccess, toToolResponse, type ToolExecutionResult } from './mcp-helpers.js';
import { formatError } from './utils.js';

export function buildStaticScaffolding(goal?: string): string {
  const focusLine = goal
    ? `> Focus for this session: ${goal}`
    : '> Focus for this session: not yet specified — set one on the next pass';

  return [
    '# Research session started',
    '',
    'You are running a research LOOP, not answering from memory. Training data is stale; the web is authoritative for anything dated, versioned, priced, or contested. Every claim in your final answer must be traceable to a scraped page or expanded Reddit thread. Never cite a URL from a search snippet alone — only from a `scrape-links` excerpt you actually read.',
    '',
    focusLine,
    '',
    '## Concept groups — the core mental model',
    '',
    'A concept group is a cluster of semantically related queries that all probe the SAME facet of the goal. Different concept groups probe DIFFERENT facets. They must not overlap — if two groups share a core noun-phrase and differ only in adjectives, collapse them.',
    '',
    '**Sizing**: roughly ~100 words of queries per group (5–10 short queries, or 4–6 longer ones). Total concept-group count matches goal complexity, not a fixed range:',
    '- Narrow technical bug → 2–3 groups',
    '- Comparison / pricing → 4–6 groups',
    '- Open-ended synthesis → 8+ groups',
    '',
    '**Axis menu** (pick the axes the goal demands; invent new axes when needed — this is not a checklist):',
    '- Official spec / vendor docs',
    '- Source / implementation (GitHub code, RFCs)',
    '- Platform / compatibility gap',
    '- Failure / bug reports',
    '- Community sentiment / lived experience',
    '- Changelog / release notes / recent changes',
    '- Pricing / tier limits / enterprise',
    '- Security advisories / CVE databases',
    '- Academic / arxiv / benchmark papers',
    '- Regulatory filings / compliance',
    '',
    '**Fire all concept groups in ONE `web-search` call** (flat array of queries). The classifier dedupes and ranks across groups.',
    '',
    '## The research loop',
    '',
    '1. **Produce concept groups → fire `web-search` once** (all groups\' queries concatenated into the flat array).',
    '2. **Read the classifier output**: `synthesis` (terrain), `gaps` (what\'s missing, with ids), `refine_queries` (follow-ups tied to gap ids).',
    '3. **Scrape with `scrape-links`**: every HIGHLY_RELEVANT plus the 2–3 best MAYBE_RELEVANT. One batched call. Treat `extract` as a **semantic instruction** — describe the SHAPE of what you want, not exact words to match. Use `|` to separate facets. Good: `root cause | affected versions | fix | workarounds | timeline`.',
    '4. **Read every scrape excerpt** — extract new terms, version numbers, vendor names, failure modes from the `## Follow-up signals` section of each extract. These seed the next-pass concept groups.',
    '5. **Next pass: close the gaps.** Build new concept groups targeting each `gaps[]` item. Do not repeat a group unless pass 1 returned fewer than 3 distinct HIGHLY_RELEVANT sources for it.',
    '6. **Stop when**: (a) every gap is closed AND no new terms appeared in the last pass, OR (b) you have run 4 passes — whichever comes first. State remaining gaps explicitly if you hit the cap.',
    '',
    '## Reddit branch — fire ONLY when the goal is about',
    '',
    '- Sentiment / developer reception',
    '- Migration stories / "we moved from X to Y"',
    '- Lived experience / production war stories',
    '- Community consensus on an opinion-heavy topic',
    '',
    '**Do NOT fire Reddit for**: CVE lookups, API spec questions, pricing pages, primary-source documentation hunts. Reddit adds noise on these.',
    '',
    'When firing: `search-reddit` → then `get-reddit-post` on the 3–10 strongest threads. Never cite a Reddit thread you have not expanded with `get-reddit-post`.',
    '',
    '## Post-cutoff entity discipline',
    '',
    'For anything released or changed after your training cutoff — new products, versions, prices, benchmarks — **treat your own query suggestions as hypotheses until confirmed by a scraped first-party page**. One concept group for vendor/product goals MUST be `site:<vendor-domain>` queries.',
    '',
    '## Output discipline',
    '',
    '- Cite URL (or Reddit thread permalink) for every non-trivial claim.',
    '- Separate **documented facts** from **inferred conclusions** explicitly.',
    '- Include the date you scraped time-sensitive claims.',
    '- If you could not verify something, say so — do not paper over gaps.',
    '- Never cite a URL from a search snippet — only from a scrape excerpt you read.',
  ].join('\n');
}

/**
 * Backward-compat alias — older tests import `buildOrientation` directly.
 * New code should use `buildStaticScaffolding` (sync) for the static part,
 * and the full `handleStartResearch` handler for the goal-aware version.
 */
export const buildOrientation = buildStaticScaffolding;

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
  workflowKey: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<StartResearchOutput>> {
  try {
    const store = getWorkflowStateStore();

    // Always unlock the session first — bootstrap gate must not depend on LLM availability.
    await store.patch(workflowKey, {
      bootstrapped: true,
      bootstrappedAt: new Date().toISOString(),
    });

    const scaffolding = buildStaticScaffolding(params.goal);

    let brief = '';
    if (params.goal) {
      brief = await buildGoalAwareBrief(params.goal, signal);
    }

    // If a goal was provided but the brief is empty, tell the caller why — otherwise
    // they cannot distinguish "no goal" from "goal-aware planner failed."
    const briefFallbackNote = params.goal && !brief
      ? '\n\n---\n\n> _Goal-tailored brief unavailable: LLM planner is not configured or failed this call. The static playbook above still applies; you can proceed with it, or retry `start-research` after verifying `LLM_API_KEY`._'
      : '';

    const content = brief
      ? `${scaffolding}\n\n---\n\n${brief}`
      : `${scaffolding}${briefFallbackNote}`;

    return toolSuccess(content, { content });
  } catch (err: unknown) {
    const structuredError = classifyError(err);
    mcpLog('error', `start-research: ${structuredError.message}`, 'start-research');
    return toolFailure(
      formatError({
        code: structuredError.code,
        message: structuredError.message,
        retryable: structuredError.retryable,
        toolName: 'start-research',
        howToFix: ['Retry start-research. If the failure persists, verify the workflow-state store (Redis) and LLM_API_KEY.'],
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
        'MANDATORY first call for every research session. Returns a goal-tailored research brief — initial concept groups, source-type priorities, anticipated gaps, and success criteria customized to your specific goal — plus the full research loop playbook (concept-group mental model, scrape discipline, Reddit branch rules, output discipline). Provide a `goal` to get the tailored brief; without one you get the generic playbook. Other tools are gated until this is called.',
      schema: startResearchParamsSchema,
      outputSchema: startResearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, ctx) => toToolResponse(await handleStartResearch(args, buildWorkflowKey(ctx))),
  );
}
