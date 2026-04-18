import assert from 'node:assert/strict';
import test from 'node:test';

import { webSearchParamsSchema } from '../src/schemas/web-search.js';

test('webSearchParamsSchema accepts scope: "reddit"', () => {
  const parsed = webSearchParamsSchema.parse({
    queries: ['mcp oauth'],
    extract: 'community advice',
    scope: 'reddit',
  });
  assert.equal(parsed.scope, 'reddit');
});

test('webSearchParamsSchema accepts scope: "both"', () => {
  const parsed = webSearchParamsSchema.parse({
    queries: ['mcp oauth'],
    extract: 'community advice',
    scope: 'both',
  });
  assert.equal(parsed.scope, 'both');
});

test('webSearchParamsSchema defaults scope to "web"', () => {
  const parsed = webSearchParamsSchema.parse({
    queries: ['mcp oauth'],
    extract: 'community advice',
  });
  assert.equal(parsed.scope, 'web');
});

test('webSearchParamsSchema rejects unknown scope', () => {
  assert.throws(() => webSearchParamsSchema.parse({
    queries: ['x'],
    extract: 'y',
    scope: 'twitter',
  }));
});
