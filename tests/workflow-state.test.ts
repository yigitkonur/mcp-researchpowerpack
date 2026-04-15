import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryWorkflowStateStore,
  emptyWorkflowState,
} from '../src/services/workflow-state.js';

test('returns empty state for unknown key', async () => {
  const store = createMemoryWorkflowStateStore();
  assert.deepEqual(await store.get('session:missing'), emptyWorkflowState());
});

test('patch merges state and preserves unspecified fields', async () => {
  const store = createMemoryWorkflowStateStore();
  await store.patch('session:abc', {
    bootstrapped: true,
    bootstrappedAt: '2026-04-15T00:00:00.000Z',
  });

  const next = await store.patch('session:abc', { redditWarningShown: true });

  assert.deepEqual(next, {
    bootstrapped: true,
    bootstrappedAt: '2026-04-15T00:00:00.000Z',
    redditWarningShown: true,
    orientationVersion: 1,
  });
});
