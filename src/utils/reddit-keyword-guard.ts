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
    '❌ Putting `reddit` in a `web-search` query without setting the scope flag wastes a turn — the result is biased toward subreddit homepages and namesake hits.',
    '',
    `Blocked query: ${matchedQuery}`,
    '',
    'For Reddit discovery, call `web-search` with `scope: "reddit"` — the server appends `site:reddit.com` and filters results to post permalinks. For non-Reddit web search, drop the word "reddit" from the query.',
  ].join('\n'));
}
