import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeQueryForDispatch,
  relaxQueryForRetry,
} from '../src/utils/query-relax.js';

// ── Phase A: positives ──

test('A3: 4 consecutive quoted phrases → anchor + OR group', () => {
  const r = normalizeQueryForDispatch('"Kimi" "work_dir_hash" "session_id" "context.jsonl"');
  assert.equal(r.rewritten, '"Kimi" "work_dir_hash" OR "session_id" OR "context.jsonl"');
  assert.deepEqual(r.rules, ['A3']);
  assert.equal(r.changed, true);
});

test('A3: trailing bare word preserved verbatim', () => {
  const r = normalizeQueryForDispatch('"Kimi" "state.json" "wire.jsonl" "context.jsonl" parser');
  assert.equal(r.rewritten, '"Kimi" "state.json" OR "wire.jsonl" OR "context.jsonl" parser');
  assert.deepEqual(r.rules, ['A3']);
});

test('A3: 6 phrases with trailing bare word', () => {
  const r = normalizeQueryForDispatch('"Kiro IDE" "modelId" "startTime" "endTime" "chat" "metadata" GitHub');
  assert.equal(
    r.rewritten,
    '"Kiro IDE" "modelId" OR "startTime" OR "endTime" OR "chat" OR "metadata" GitHub',
  );
  assert.deepEqual(r.rules, ['A3']);
});

test('A1: phrase with parens+colon de-quoted, chars stripped', () => {
  const r = normalizeQueryForDispatch('"feat(kimi): implement Kimi CLI usage tracking"');
  assert.equal(r.rewritten, 'feat kimi  implement Kimi CLI usage tracking'.replace(/\s+/g, ' '));
  assert.deepEqual(r.rules, ['A1']);
});

test('A2: tilde+slash phrase de-quoted; sibling phrases stay quoted', () => {
  const r = normalizeQueryForDispatch('"~/.kiro" "data.sqlite3" "session"');
  assert.equal(r.rewritten, '~/.kiro "data.sqlite3" "session"');
  assert.deepEqual(r.rules, ['A2']);
});

test('A2: github.com path de-quoted', () => {
  const r = normalizeQueryForDispatch('"github.com/miss-you/codetok/provider/kimi"');
  assert.equal(r.rewritten, 'github.com/miss-you/codetok/provider/kimi');
  assert.deepEqual(r.rules, ['A2']);
});

test('A1+A2: combined application; A3 does not fire when count drops below 3', () => {
  // Pre-A: 4 quoted phrases. After A1 strips one, after A2 strips another →
  // 2 still-quoted; A3 must not fire.
  const r = normalizeQueryForDispatch('"feat(kimi):x" "~/.foo" "session_id" "context.jsonl"');
  assert.equal(r.rewritten, 'feat kimi x ~/.foo "session_id" "context.jsonl"');
  assert.deepEqual(r.rules, ['A1', 'A2']);
});

test('A1+A2+A3: combined application; A3 still fires when ≥3 phrases survive', () => {
  // 5 phrases: one with operator chars, one path-like, three plain.
  const r = normalizeQueryForDispatch('"feat(x):y" "~/.foo" "a" "b" "c"');
  assert.equal(r.rewritten, 'feat x y ~/.foo "a" "b" OR "c"');
  assert.deepEqual(r.rules, ['A1', 'A2', 'A3']);
});

test('A3 with site: operator preserved verbatim', () => {
  const r = normalizeQueryForDispatch('site:github.com "a" "b" "c" "d"');
  assert.equal(r.rewritten, 'site:github.com "a" "b" OR "c" OR "d"');
  assert.deepEqual(r.rules, ['A3']);
});

// ── Phase A: negatives (must not touch) ──

test('Phase A: 2 phrases unchanged', () => {
  const r = normalizeQueryForDispatch('"Kimi" "session_id"');
  assert.equal(r.rewritten, '"Kimi" "session_id"');
  assert.equal(r.changed, false);
  assert.deepEqual(r.rules, []);
});

test('Phase A: existing OR grouping unchanged', () => {
  const r = normalizeQueryForDispatch('"a" OR "b" OR "c"');
  assert.equal(r.changed, false);
  assert.deepEqual(r.rules, []);
});

test('Phase A: existing parens grouping unchanged', () => {
  const r = normalizeQueryForDispatch('("a" OR "b") "c"');
  assert.equal(r.changed, false);
  assert.deepEqual(r.rules, []);
});

test('Phase A: no quoted phrases unchanged', () => {
  const r = normalizeQueryForDispatch('site:reddit.com kimi context');
  assert.equal(r.changed, false);
  assert.deepEqual(r.rules, []);
});

test('Phase A: empty query', () => {
  const r = normalizeQueryForDispatch('');
  assert.equal(r.rewritten, '');
  assert.equal(r.changed, false);
});

test('Phase A: whitespace-only query', () => {
  const r = normalizeQueryForDispatch('   ');
  assert.equal(r.rewritten, '');
  assert.equal(r.changed, false);
});

test('Phase A: phrases interrupted by bare word — only consecutive run gets OR', () => {
  // 3 phrases with a bare word splitting them. A3 fires (count=3) but only
  // the whitespace-only raw between phrase #2 and #3 gets OR-ified.
  const r = normalizeQueryForDispatch('"a" foo "b" "c"');
  assert.equal(r.rewritten, '"a" foo "b" OR "c"');
  assert.deepEqual(r.rules, ['A3']);
});

// ── Phase B: positives ──

test('B1: strip all quotes', () => {
  const r = relaxQueryForRetry('"Kimi" "session_id"');
  assert.equal(r.rewritten, 'Kimi session_id');
  assert.deepEqual(r.rules, ['B1']);
});

test('B2: drop site: operator', () => {
  const r = relaxQueryForRetry('site:status.kernel.sh Kernel status RSS incidents');
  assert.equal(r.rewritten, 'Kernel status RSS incidents');
  assert.deepEqual(r.rules, ['B2']);
});

test('B1+B2: strip quotes and site: filter', () => {
  const r = relaxQueryForRetry('site:browse.dev "Meteor"');
  assert.equal(r.rewritten, 'Meteor');
  assert.deepEqual(r.rules, ['B1', 'B2']);
});

test('B1: post-A3 form is retried by stripping quotes', () => {
  const r = relaxQueryForRetry('"Kimi" "work_dir_hash" OR "session_id" OR "context.jsonl"');
  assert.equal(r.rewritten, 'Kimi work_dir_hash OR session_id OR context.jsonl');
  assert.deepEqual(r.rules, ['B1']);
});

// ── Phase B: negatives ──

test('Phase B: bare-word-only query unchanged (skip retry)', () => {
  const r = relaxQueryForRetry('kimi context');
  assert.equal(r.changed, false);
  assert.deepEqual(r.rules, []);
});

test('Phase B: empty query unchanged', () => {
  const r = relaxQueryForRetry('');
  assert.equal(r.changed, false);
});
