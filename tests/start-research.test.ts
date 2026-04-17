import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrientation, buildStaticScaffolding } from '../src/tools/start-research.js';

test('static scaffolding covers concept groups, research loop, and output discipline', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /## Concept groups — the core mental model/);
  assert.match(markdown, /## The research loop/);
  assert.match(markdown, /## Reddit branch/);
  assert.match(markdown, /## Output discipline/);
  assert.match(markdown, /Never cite a URL from a search snippet/i);
  assert.match(markdown, /`scrape-links`/);
});

test('static scaffolding teaches concept-group sizing and distinctness rule', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /Narrow technical bug → 2–3 groups/);
  assert.match(markdown, /Open-ended synthesis → 8\+ groups/);
  assert.match(markdown, /they must not overlap/i);
});

test('static scaffolding enumerates the Reddit-branch negative list', () => {
  const markdown = buildStaticScaffolding();

  assert.match(markdown, /Do NOT fire Reddit for/);
  assert.match(markdown, /CVE lookups/);
  assert.match(markdown, /API spec questions/);
  assert.match(markdown, /pricing pages/);
});

test('includes the focus line when a goal is provided', () => {
  const markdown = buildStaticScaffolding('investigate MCP OAuth support');

  assert.match(markdown, /> Focus for this session: investigate MCP OAuth support/);
});

test('buildOrientation is exported as a backward-compat alias', () => {
  assert.equal(buildOrientation, buildStaticScaffolding);
});
