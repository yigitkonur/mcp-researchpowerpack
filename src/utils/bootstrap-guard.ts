import { error, type TypedCallToolResult } from 'mcp-use/server';

import { getWorkflowStateStore } from '../services/workflow-state.js';
import { buildWorkflowKey, type WorkflowKeyContext } from './workflow-key.js';

export const BOOTSTRAP_MESSAGE = [
  '❌ Research session not started.',
  '',
  'Call `start-research` once before using the research tools.',
  '',
  'After bootstrap you can use:',
  '- `web-search`',
  '- `search-reddit`',
  '- `get-reddit-post`',
  '- `scrape-links`',
  '',
  'This is a one-time orientation step per conversation/session.',
].join('\n');

export async function requireBootstrap(
  ctx: WorkflowKeyContext,
): Promise<TypedCallToolResult<never> | null> {
  const store = getWorkflowStateStore();
  const state = await store.get(buildWorkflowKey(ctx));

  return state.bootstrapped ? null : error(BOOTSTRAP_MESSAGE);
}
