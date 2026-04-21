import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStartHereSection } from '../src/tools/search.js';
import type { ClassificationEntry } from '../src/services/llm-processor.js';

interface Candidate {
  rank: number;
  url: string;
  title: string;
}

function mkCandidate(rank: number, path = `/r${rank}`, host = 'example.com'): Candidate {
  return {
    rank,
    url: `https://${host}${path}`,
    title: `Title for ${rank}`,
  };
}

function mkEntry(rank: number, overrides: Partial<ClassificationEntry> = {}): ClassificationEntry {
  return {
    rank,
    tier: 'HIGHLY_RELEVANT',
    reason: `reason ${rank}`,
    ...overrides,
  };
}

function entriesByRank(entries: ClassificationEntry[]): Map<number, ClassificationEntry> {
  return new Map(entries.map((e) => [e.rank, e]));
}

test('all OTHER tier → returns empty string (no section emitted)', () => {
  const out = buildStartHereSection(
    { high: [], maybe: [] },
    entriesByRank([
      mkEntry(1, { tier: 'OTHER' }),
      mkEntry(2, { tier: 'OTHER' }),
      mkEntry(3, { tier: 'OTHER' }),
    ]),
  );
  assert.equal(out, '');
});

test('five HIGHLY_RELEVANT → renders exactly 5 entries', () => {
  const high = [1, 2, 3, 4, 5].map((r) => mkCandidate(r));
  const entries = high.map((c) => mkEntry(c.rank));
  const out = buildStartHereSection({ high, maybe: [] }, entriesByRank(entries));
  assert.ok(out.startsWith('## Start here'));
  // Exactly 5 numbered lines
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 5);
  // Each line has title, url, reason, tier tag, rank
  for (let i = 0; i < 5; i += 1) {
    assert.match(numbered[i]!, /Title for/);
    assert.match(numbered[i]!, /reason/);
    assert.match(numbered[i]!, /HIGHLY_RELEVANT/);
    assert.match(numbered[i]!, /rank \d/);
  }
});

test('seven HIGHLY_RELEVANT → capped at 5 (never exceeds max)', () => {
  const high = [1, 2, 3, 4, 5, 6, 7].map((r) => mkCandidate(r));
  const entries = high.map((c) => mkEntry(c.rank));
  const out = buildStartHereSection({ high, maybe: [] }, entriesByRank(entries));
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 5);
});

test('one HIGHLY + four MAYBE → pads from maybe up to 3 total', () => {
  const high = [mkCandidate(1)];
  const maybe = [2, 3, 4, 5].map((r) => mkCandidate(r));
  const entries = [
    mkEntry(1, { tier: 'HIGHLY_RELEVANT' }),
    mkEntry(2, { tier: 'MAYBE_RELEVANT' }),
    mkEntry(3, { tier: 'MAYBE_RELEVANT' }),
    mkEntry(4, { tier: 'MAYBE_RELEVANT' }),
    mkEntry(5, { tier: 'MAYBE_RELEVANT' }),
  ];
  const out = buildStartHereSection({ high, maybe }, entriesByRank(entries));
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 3, 'padded up to minimum of 3');
  // First entry is HIGHLY_RELEVANT, next two are MAYBE_RELEVANT
  assert.match(numbered[0]!, /HIGHLY_RELEVANT/);
  assert.match(numbered[1]!, /MAYBE_RELEVANT/);
  assert.match(numbered[2]!, /MAYBE_RELEVANT/);
});

test('one HIGHLY + zero MAYBE → exactly 1 entry (no padding available)', () => {
  const high = [mkCandidate(1)];
  const out = buildStartHereSection(
    { high, maybe: [] },
    entriesByRank([mkEntry(1)]),
  );
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 1);
  assert.match(numbered[0]!, /HIGHLY_RELEVANT/);
});

test('three HIGHLY + many MAYBE → exactly 3 (no padding needed)', () => {
  const high = [1, 2, 3].map((r) => mkCandidate(r));
  const maybe = [4, 5, 6, 7, 8].map((r) => mkCandidate(r));
  const entries = [
    ...high.map((c) => mkEntry(c.rank, { tier: 'HIGHLY_RELEVANT' })),
    ...maybe.map((c) => mkEntry(c.rank, { tier: 'MAYBE_RELEVANT' })),
  ];
  const out = buildStartHereSection({ high, maybe }, entriesByRank(entries));
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 3);
  // All three should be HIGHLY_RELEVANT — no padding when high tier has ≥3
  for (const line of numbered) assert.match(line!, /HIGHLY_RELEVANT/);
});

test('domain is extracted correctly (www stripped, invalid URLs fall back)', () => {
  const out = buildStartHereSection(
    {
      high: [
        mkCandidate(1, '/a', 'www.cursor.com'),
        mkCandidate(2, '/b', 'docs.github.com'),
        mkCandidate(3, '/c', 'reddit.com'),
      ],
      maybe: [],
    },
    entriesByRank([1, 2, 3].map((r) => mkEntry(r))),
  );
  // www. prefix stripped
  assert.match(out, / — cursor\.com — /);
  // Non-www domains preserved as-is
  assert.match(out, / — docs\.github\.com — /);
  assert.match(out, / — reddit\.com — /);
});

test('entry without reason renders "—" placeholder', () => {
  const out = buildStartHereSection(
    { high: [mkCandidate(1)], maybe: [] },
    entriesByRank([{ rank: 1, tier: 'HIGHLY_RELEVANT' }]), // no reason field
  );
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 1);
  assert.match(numbered[0]!, / — — /, 'missing reason should render as em-dash placeholder');
});

test('custom min/max options are respected', () => {
  const high = [1, 2].map((r) => mkCandidate(r));
  const maybe = [3, 4, 5, 6].map((r) => mkCandidate(r));
  const entries = [
    ...high.map((c) => mkEntry(c.rank, { tier: 'HIGHLY_RELEVANT' })),
    ...maybe.map((c) => mkEntry(c.rank, { tier: 'MAYBE_RELEVANT' })),
  ];
  // min=5, max=5 → should pad all the way up to 5
  const out = buildStartHereSection({ high, maybe }, entriesByRank(entries), { min: 5, max: 5 });
  const numbered = out.split('\n').filter((l) => /^[1-9]\. /.test(l));
  assert.equal(numbered.length, 5);
});

test('header is exactly one line and section ends without trailing blank', () => {
  const out = buildStartHereSection(
    { high: [mkCandidate(1), mkCandidate(2), mkCandidate(3)], maybe: [] },
    entriesByRank([1, 2, 3].map((r) => mkEntry(r))),
  );
  const sectionLines = out.split('\n');
  assert.equal(sectionLines[0], '## Start here — best candidates for your extract');
  // Last content line should be a numbered entry (no trailing blank from helper itself —
  // the outer renderer manages blanks between sections)
  assert.match(sectionLines[sectionLines.length - 1]!, /^[1-9]\. /);
});
