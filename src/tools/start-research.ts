import type { MCPServer } from 'mcp-use/server';

import {
  startResearchOutputSchema,
  startResearchParamsSchema,
  type StartResearchOutput,
  type StartResearchParams,
} from '../schemas/start-research.js';
import { getWorkflowStateStore } from '../services/workflow-state.js';
import { buildWorkflowKey } from '../utils/workflow-key.js';
import { toolSuccess, toToolResponse, type ToolExecutionResult } from './mcp-helpers.js';

export function buildOrientation(goal?: string): string {
  const lines = [
    '# Research session started',
    '',
    'Work in loops, not one-shot searches.',
    '',
    goal ? `> Focus for this session: ${goal}` : null,
    '1. Start broad with `web-search` (optionally use `search-reddit` for practitioner signal, sentiment, migration stories, or production pain).',
    '   Each `web-search` call can include up to 100 queries, so prefer many diverse search angles and back-to-back search passes over a few paraphrases.',
    '2. Use `scrape-links` on the strongest URLs.',
    '   Turn search leads into evidence by scraping the best docs, changelogs, issue threads, and articles.',
    '   Treat `extract` as a semantic instruction: describe the information to keep, not exact words to match, so semantically similar phrases are still captured.',
    '   Good examples: `root cause | fix | affected versions | workarounds` or `pricing tiers | rate limits | enterprise availability`.',
    '3. Loop back after every result set.',
    '   If a result reveals a new term, version, failure mode, competitor, or migration path, search again.',
    '4. If you take the Reddit branch, use `get-reddit-post` only after `search-reddit`.',
    '5. Prefer evidence over snippets. Search results are leads; scraped pages and expanded threads are evidence.',
  ].filter(Boolean) as string[];

  return lines.join('\n');
}

async function handleStartResearch(
  params: StartResearchParams,
  workflowKey: string,
): Promise<ToolExecutionResult<StartResearchOutput>> {
  const store = getWorkflowStateStore();

  await store.patch(workflowKey, {
    bootstrapped: true,
    bootstrappedAt: new Date().toISOString(),
  });

  const content = buildOrientation(params.goal);
  return toolSuccess(content, { content });
}

export function registerStartResearchTool(server: MCPServer): void {
  server.tool(
    {
      name: 'start-research',
      title: 'Start Research Session',
      description:
        'One-time orientation tool. Call this first to unlock the research workflow for the current conversation/session.',
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
