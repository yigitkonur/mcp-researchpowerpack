import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectTerseFailure,
  mergeLlmWithRawFallback,
  RAW_FALLBACK_CHAR_CAP,
} from '../src/tools/scrape.js';

// ── detectTerseFailure ─────────────────────────────────────────────────────
// The LLM extraction prompt instructs the model to emit a single terse line
// when a page "clearly failed to load". We must recognize each of the 6
// canonical reasons with casing + whitespace tolerance, and NOT match normal
// 4-section extraction output (which can also contain "## Matches" followed by
// bullets).

const CANONICAL_REASONS = [
  '404',
  'login-wall',
  'paywall',
  'JS-render-empty',
  'non-text-asset',
  'truncated-before-relevant-section',
];

for (const reason of CANONICAL_REASONS) {
  test(`detectTerseFailure: matches canonical reason "${reason}"`, () => {
    const line = `## Matches\n_Page did not load: ${reason}_`;
    assert.equal(detectTerseFailure(line), reason);
  });
}

test('detectTerseFailure: tolerates leading/trailing whitespace', () => {
  const line = '\n\n  ## Matches\n\n_Page did not load: login-wall_  \n';
  assert.equal(detectTerseFailure(line), 'login-wall');
});

test('detectTerseFailure: tolerates trailing period', () => {
  const line = '## Matches\n_Page did not load: paywall_.';
  assert.equal(detectTerseFailure(line), 'paywall');
});

test('detectTerseFailure: returns null for rich extraction output', () => {
  const richOutput = [
    '## Source',
    '- URL: https://example.com/',
    '- Page type: blog',
    '',
    '## Matches',
    '- **headline** — `Snowflake bets on agents`',
    '- **date** — `2026-04-08`',
    '',
    '## Not found',
    '- Pricing — not present on this page.',
  ].join('\n');
  assert.equal(detectTerseFailure(richOutput), null);
});

test('detectTerseFailure: returns null when the page-did-not-load line is embedded, not the entire output', () => {
  const embedded = [
    '## Source',
    '- URL: https://example.com/',
    '',
    '## Matches',
    '_Page did not load: login-wall_',
    '',
    '## Not found',
    '- Everything — page gated.',
  ].join('\n');
  assert.equal(detectTerseFailure(embedded), null);
});

test('detectTerseFailure: returns null for empty string', () => {
  assert.equal(detectTerseFailure(''), null);
  assert.equal(detectTerseFailure('   \n  '), null);
});

// ── mergeLlmWithRawFallback ────────────────────────────────────────────────
// When the LLM emits the terse escape line, we append the raw cleaned
// markdown under "## Raw content (LLM flagged page as <reason>)" so the
// caller always has the scraped body to inspect.

test('mergeLlmWithRawFallback: appends raw content when LLM emits terse line', () => {
  const llmOutput = '## Matches\n_Page did not load: login-wall_';
  const raw = '# LinkedIn\n\nYou must sign in to continue. Preview: Elon Musk — CEO, Tesla...';
  const merged = mergeLlmWithRawFallback(llmOutput, raw);
  assert.match(merged, /## Raw content \(LLM flagged page as login-wall\)/);
  assert.ok(merged.includes('Elon Musk — CEO, Tesla'), 'raw preview text must be preserved');
  assert.ok(merged.startsWith('## Matches\n_Page did not load: login-wall_'), 'terse verdict must remain at the top');
});

test('mergeLlmWithRawFallback: no-op when LLM output is rich', () => {
  const richOutput = '## Source\n- URL: https://example.com/\n\n## Matches\n- **headline** — `X`';
  const raw = '# Example\n\nThis is the scraped body.';
  const merged = mergeLlmWithRawFallback(richOutput, raw);
  assert.equal(merged, richOutput, 'rich LLM output must pass through unchanged');
});

test('mergeLlmWithRawFallback: no-op when rawContent is undefined', () => {
  const llmOutput = '## Matches\n_Page did not load: paywall_';
  const merged = mergeLlmWithRawFallback(llmOutput, undefined);
  assert.equal(merged, llmOutput);
});

test('mergeLlmWithRawFallback: no-op when rawContent is empty/whitespace', () => {
  const llmOutput = '## Matches\n_Page did not load: paywall_';
  assert.equal(mergeLlmWithRawFallback(llmOutput, ''), llmOutput);
  assert.equal(mergeLlmWithRawFallback(llmOutput, '   \n  '), llmOutput);
});

test('mergeLlmWithRawFallback: truncates raw content beyond the cap', () => {
  const llmOutput = '## Matches\n_Page did not load: JS-render-empty_';
  const raw = 'x'.repeat(RAW_FALLBACK_CHAR_CAP + 4000);
  const merged = mergeLlmWithRawFallback(llmOutput, raw);
  assert.match(merged, /…\[raw truncated\]$/);
  // header boilerplate ≈ 80 chars, so total length ≤ cap + 200 is plenty
  assert.ok(merged.length <= RAW_FALLBACK_CHAR_CAP + 200, `merged length ${merged.length} exceeded expected envelope`);
});

test('mergeLlmWithRawFallback: does NOT truncate raw content under the cap', () => {
  const llmOutput = '## Matches\n_Page did not load: 404_';
  const raw = 'short body under the cap';
  const merged = mergeLlmWithRawFallback(llmOutput, raw);
  assert.ok(merged.includes(raw));
  assert.doesNotMatch(merged, /raw truncated/);
});
