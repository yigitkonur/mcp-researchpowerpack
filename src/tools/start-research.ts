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

function buildOrientation(goal?: string): string {
  const lines = [
    '# Research session started',
    '',
    goal ? `> Focus for this session: ${goal}` : null,
    '1. Start with broad, diverse queries in `web-search`.',
    '2. Use `search-reddit` for lived experience and community discussion.',
    '3. Use `get-reddit-post` to expand shortlisted Reddit threads.',
    '4. Use `scrape-links` on the best consensus URLs.',
    '5. Iterate using signals from previous tool results.',
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
