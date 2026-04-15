import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrientation } from '../src/tools/start-research.js';

test('start-research teaches broader web-search usage and the scrape loop', () => {
  const markdown = buildOrientation();

  assert.match(markdown, /up to 100 queries/i);
  assert.match(markdown, /optionally use `search-reddit`/i);
  assert.match(markdown, /Use `scrape-links` on the strongest URLs/i);
  assert.match(markdown, /semantic instruction/i);
  assert.match(markdown, /not exact words to match/i);
  assert.match(markdown, /search again/i);
});

test('start-research includes the optional focus line when a goal is provided', () => {
  const markdown = buildOrientation('investigate MCP OAuth support');

  assert.match(markdown, /> Focus for this session: investigate MCP OAuth support/);
});
