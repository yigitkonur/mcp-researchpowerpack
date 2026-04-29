import assert from 'node:assert/strict';
import test from 'node:test';

import { formatJinaFailure } from '../src/tools/scrape.js';

// ── formatJinaFailure ──────────────────────────────────────────────────────
// This formatter is the user-visible artifact of the two-layer fallback.
// When Jina alone fails, the output is a single-layer error. When Jina
// fails *after* Scrape.do already failed, the output must name both layers
// so the caller knows the URL is genuinely unreachable — not just a Jina
// hiccup.

test('formatJinaFailure: Jina-only failure (no prior scrape error)', () => {
  const line = formatJinaFailure('https://example.com/foo.pdf', 'Timeout after 30s');
  assert.match(line, /^## https:\/\/example\.com\/foo\.pdf\n/);
  assert.match(line, /Document conversion failed: Timeout after 30s/);
  assert.doesNotMatch(line, /Both scrapers failed/);
});

test('formatJinaFailure: both scrapers failed (prior scrape error present)', () => {
  const line = formatJinaFailure(
    'https://portal.myk.gov.tr/index.php?option=com_istatistik',
    'Rate limited by Jina',
    'HTTP 302 redirect loop',
  );
  assert.match(line, /Both scrapers failed/);
  assert.match(line, /Scrape\.do: HTTP 302 redirect loop/);
  assert.match(line, /Jina Reader: Rate limited by Jina/);
});

test('formatJinaFailure: treats empty scrapeError string as no-context', () => {
  // Empty string is falsy; should take the single-layer path.
  const line = formatJinaFailure('https://example.com/x.pdf', 'Invalid URL', '');
  assert.match(line, /Document conversion failed: Invalid URL/);
  assert.doesNotMatch(line, /Both scrapers failed/);
});
