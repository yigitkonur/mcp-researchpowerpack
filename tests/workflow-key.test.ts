import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkflowKey } from '../src/utils/workflow-key.js';

function makeCtx(user?: {
  subject?: string;
  conversationId?: string;
}) {
  return {
    session: { sessionId: 'session-123' },
    client: { user: () => user },
  } as const;
}

test('uses subject + conversationId when both are present', () => {
  assert.equal(
    buildWorkflowKey(makeCtx({ subject: 'sub-1', conversationId: 'conv-9' })),
    'chatgpt:sub-1:conv-9',
  );
});

test('uses conversationId when subject is absent', () => {
  assert.equal(
    buildWorkflowKey(makeCtx({ conversationId: 'conv-9' })),
    'conversation:conv-9',
  );
});

test('falls back to sessionId when user metadata is absent', () => {
  assert.equal(buildWorkflowKey(makeCtx()), 'session:session-123');
});
