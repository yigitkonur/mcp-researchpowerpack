import { error, type TypedCallToolResult } from 'mcp-use/server';

import { getWorkflowStateStore } from '../services/workflow-state.js';
import { buildWorkflowKey, type WorkflowKeyContext } from './workflow-key.js';

export const BOOTSTRAP_MESSAGE = [
  '❌ Research session not started.',
  '',
  'Call `start-research` once before using the research tools. Pass a `goal` to get a tailored research brief — classified goal type, source priorities, a Reddit-branch recommendation, 3–8 ready-to-fire concept groups (25–50 queries), anticipated gaps, first-pass scrape targets, and success criteria. Without a goal you get only the generic research-loop playbook.',
  '',
  'Example: `start-research {"goal": "Verify if feature X works on platform Y"}`',
  '',
  'After bootstrap you can use:',
  '- `web-search` — fan out concept-group queries; returns tiered results with gaps and linked follow-ups. Pass `scope: "reddit"` for Reddit discovery (post permalinks only, no subreddit homepages).',
  '- `get-reddit-post` — expand Reddit threads before citing',
  '- `scrape-links` — structured extraction with page-type-aware emphasis and a follow-up-signals bulletin',
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
