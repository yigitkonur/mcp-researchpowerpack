import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryWorkflowStateStore } from '../src/services/workflow-state.js';
import { redditKeywordGuard } from '../src/utils/reddit-keyword-guard.js';

function makeCtx() {
  return {
    session: { sessionId: 'session-1' },
    client: { user: () => undefined },
  } as const;
}

test('blocks the first reddit keyword hit and marks the warning as shown', async () => {
  const store = createMemoryWorkflowStateStore();

  const result = await redditKeywordGuard(makeCtx(), ['reddit mcp oauth'], store);
  assert.equal(result?.isError, true);
  // Guidance now points to web-search scope:"reddit" (search-reddit was deleted).
  assert.match(JSON.stringify(result), /scope/);
  assert.match(JSON.stringify(result), /reddit/);

  const state = await store.get('session:session-1');
  assert.equal(state.redditWarningShown, true);
});

test('allows the second reddit keyword hit through', async () => {
  const store = createMemoryWorkflowStateStore();
  await store.patch('session:session-1', { redditWarningShown: true });

  const result = await redditKeywordGuard(makeCtx(), ['reddit mcp oauth'], store);
  assert.equal(result, null);
});

test('does not match partial words', async () => {
  const store = createMemoryWorkflowStateStore();

  const result = await redditKeywordGuard(makeCtx(), ['redditch history'], store);
  assert.equal(result, null);
});
