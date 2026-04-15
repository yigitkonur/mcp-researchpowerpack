import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSignalsAndFollowUps,
  buildSuggestedFollowUpsSection,
} from '../src/tools/search.js';

test('renders suggested follow-up searches when refine queries exist', () => {
  const markdown = buildSuggestedFollowUpsSection([
    { query: 'mcp oauth example 2026', rationale: 'get newer implementation guidance' },
    { query: 'mcp oauth site:reddit.com', rationale: 'compare community-reported issues' },
  ]);

  assert.match(markdown, /## Suggested follow-up searches/);
  assert.match(markdown, /mcp oauth example 2026/);
  assert.match(markdown, /compare community-reported issues/);
});

test('omits the section when there are no refine queries', () => {
  assert.equal(buildSuggestedFollowUpsSection([]), '');
});

test('appends follow-up searches after signals when suggestions exist', () => {
  const markdown = appendSignalsAndFollowUps(
    '## Results',
    '**Signals**\n- Coverage: 4/4 queries returned ≥3 results',
    [{ query: 'oauth mcp approval flow', rationale: 'inspect approval edge cases' }],
  );

  assert.match(markdown, /## Results/);
  assert.match(markdown, /\*\*Signals\*\*/);
  assert.match(markdown, /## Suggested follow-up searches/);
  assert.match(markdown, /oauth mcp approval flow/);
});
