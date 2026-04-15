import assert from 'node:assert/strict';
import test from 'node:test';

import { requestTextWithFallback } from '../src/services/llm-processor.js';

test('falls back to the secondary model when the primary model fails', async () => {
  const calls: string[] = [];

  const processor = {
    chat: {
      completions: {
        create: async (params: { model: string }) => {
          calls.push(params.model);
          if (calls.length === 1) {
            throw new Error('primary failed');
          }
          return {
            choices: [
              {
                message: {
                  content: '{"ok":true}',
                },
              },
            ],
          };
        },
      },
    },
  };

  const response = await requestTextWithFallback(
    processor as never,
    'Return JSON',
    200,
    'test-operation',
  );

  assert.equal(response.content, '{"ok":true}');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
});
