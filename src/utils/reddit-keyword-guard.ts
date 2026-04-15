import { error, type TypedCallToolResult } from 'mcp-use/server';

import {
  getWorkflowStateStore,
  type WorkflowStateStore,
} from '../services/workflow-state.js';
import { buildWorkflowKey, type WorkflowKeyContext } from './workflow-key.js';

const REDDIT_KEYWORD_PATTERN = /\breddit\b/i;

export async function redditKeywordGuard(
  ctx: WorkflowKeyContext,
  queries: string[],
  store: WorkflowStateStore = getWorkflowStateStore(),
): Promise<TypedCallToolResult<never> | null> {
  const matchedQuery = queries.find((query) => REDDIT_KEYWORD_PATTERN.test(query));
  if (!matchedQuery) {
    return null;
  }

  const workflowKey = buildWorkflowKey(ctx);
  const state = await store.get(workflowKey);
  if (state.redditWarningShown) {
    return null;
  }

  await store.patch(workflowKey, { redditWarningShown: true });

  return error([
    '❌ `web-search` is not the best entry point for Reddit-first discovery.',
    '',
    `Blocked query: ${matchedQuery}`,
    '',
    'Use `search-reddit` for Reddit discovery, or use an explicit non-Reddit web query first.',
  ].join('\n'));
}
