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

test('appends follow-up searches after signals when suggestions exist (verbose)', () => {
  // Signals are now gated behind verbose mode — see mcp-revisions/output-shaping/02.
  const markdown = appendSignalsAndFollowUps(
    '## Results',
    '**Signals**\n- Coverage: 4/4 queries returned ≥3 results',
    [{ query: 'oauth mcp approval flow', rationale: 'inspect approval edge cases' }],
    { includeSignals: true },
  );

  assert.match(markdown, /## Results/);
  assert.match(markdown, /\*\*Signals\*\*/);
  assert.match(markdown, /## Suggested follow-up searches/);
  assert.match(markdown, /oauth mcp approval flow/);
});

test('omits Signals section by default (non-verbose)', () => {
  const markdown = appendSignalsAndFollowUps(
    '## Results',
    '**Signals**\n- Coverage: 4/4 queries returned ≥3 results',
    [{ query: 'oauth mcp approval flow', rationale: 'inspect approval edge cases' }],
  );
  assert.match(markdown, /## Suggested follow-up searches/);
  assert.doesNotMatch(markdown, /\*\*Signals\*\*/);
});

test('renders gap-id linkage when refine query carries a gap_id', () => {
  const markdown = buildSuggestedFollowUpsSection([
    { query: 'site:docs.anthropic.com claude 4.7 context', rationale: 'confirm window', gap_id: 2 },
  ]);

  assert.match(markdown, /closes gap \[2\]/);
});

test('tolerates missing rationale without crashing', () => {
  const markdown = buildSuggestedFollowUpsSection([
    { query: 'claude opus 4.7 pricing' },
  ]);

  assert.match(markdown, /claude opus 4.7 pricing/);
  assert.doesNotMatch(markdown, /undefined/);
});

test('renders gap_description fallback when gap_id is absent (raw mode)', () => {
  const markdown = buildSuggestedFollowUpsSection([
    { query: 'pnpm hoist-pattern bug', rationale: 'narrow the repro', gap_description: 'no repro case yet' },
  ]);

  assert.match(markdown, /no repro case yet/);
});
