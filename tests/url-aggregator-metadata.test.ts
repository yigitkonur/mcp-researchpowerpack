import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateAndRank, generateUnifiedOutput } from '../src/utils/url-aggregator.js';
import type { QuerySearchResult } from '../src/clients/search.js';

function search(query: string, urls: Array<{ link: string; title: string; position: number; snippet?: string }>): QuerySearchResult {
  return {
    query,
    results: urls.map((u) => ({
      title: u.title,
      link: u.link,
      snippet: u.snippet ?? `snippet for ${u.title}`,
      position: u.position,
    })),
    totalResults: urls.length,
    related: [],
  };
}

test('threshold of 1 (low diversity) suppresses CONSENSUS labels in output', () => {
  // 3 queries, every URL distinct → frequency 1 → threshold lowers to 1 → no signal in CONSENSUS.
  const searches = [
    search('a', [{ link: 'https://x.test/a', title: 'A', position: 1 }]),
    search('b', [{ link: 'https://x.test/b', title: 'B', position: 1 }]),
    search('c', [{ link: 'https://x.test/c', title: 'C', position: 1 }]),
  ];
  const aggregation = aggregateAndRank(searches, 5);
  assert.equal(aggregation.frequencyThreshold, 1);
  const md = generateUnifiedOutput(
    aggregation.rankedUrls,
    ['a', 'b', 'c'],
    searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold,
    aggregation.thresholdNote,
  );
  assert.doesNotMatch(md, /CONSENSUS/);
});

test('single-query rows in multi-query call have no metadata header by default', () => {
  const searches = [
    search('a', [{ link: 'https://x.test/a', title: 'A', position: 1 }]),
    search('b', [{ link: 'https://x.test/b', title: 'B', position: 1 }]),
  ];
  const aggregation = aggregateAndRank(searches, 5);
  const md = generateUnifiedOutput(
    aggregation.rankedUrls,
    ['a', 'b'],
    searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold,
    aggregation.thresholdNote,
  );
  // None of the rows are seen in >1 query → metadata line should be absent.
  assert.doesNotMatch(md, /Score: \d/);
  assert.doesNotMatch(md, /Consistency:/);
});

test('verbose=true restores per-row metadata', () => {
  const searches = [
    search('a', [{ link: 'https://x.test/a', title: 'A', position: 1 }]),
    search('b', [{ link: 'https://x.test/b', title: 'B', position: 1 }]),
  ];
  const aggregation = aggregateAndRank(searches, 5);
  const md = generateUnifiedOutput(
    aggregation.rankedUrls,
    ['a', 'b'],
    searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold,
    aggregation.thresholdNote,
    true,
  );
  assert.match(md, /Score: /);
  assert.match(md, /Best pos: /);
});

test('rows seen in multiple queries always show metadata', () => {
  const searches = [
    search('a', [{ link: 'https://x.test/popular', title: 'Pop', position: 1 }]),
    search('b', [{ link: 'https://x.test/popular', title: 'Pop', position: 2 }]),
    search('c', [{ link: 'https://x.test/popular', title: 'Pop', position: 3 }]),
  ];
  const aggregation = aggregateAndRank(searches, 5);
  const md = generateUnifiedOutput(
    aggregation.rankedUrls,
    ['a', 'b', 'c'],
    searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold,
    aggregation.thresholdNote,
  );
  assert.match(md, /Score: /);
  assert.match(md, /Seen in: 3\/3/);
  assert.match(md, /Consistency: /);
});

test('"Consistency: n/a" never appears in default output', () => {
  const searches = [
    search('a', [{ link: 'https://x.test/once', title: 'Once', position: 1 }]),
    search('b', [{ link: 'https://x.test/twice', title: 'Twice', position: 1 }]),
  ];
  const aggregation = aggregateAndRank(searches, 5);
  const md = generateUnifiedOutput(
    aggregation.rankedUrls,
    ['a', 'b'],
    searches,
    aggregation.totalUniqueUrls,
    aggregation.frequencyThreshold,
    aggregation.thresholdNote,
  );
  assert.doesNotMatch(md, /Consistency: n\/a/);
});
