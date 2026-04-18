import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStaticScaffolding } from '../src/tools/start-research.js';

test('scaffolding promises classifier output when planner is available', () => {
  const md = buildStaticScaffolding('foo', { plannerAvailable: true });
  assert.match(md, /classifier output/);
  assert.match(md, /synthesis/);
  assert.match(md, /gaps/);
  assert.match(md, /refine_queries/);
});

test('scaffolding drops the classifier-output promise when planner is offline', () => {
  const md = buildStaticScaffolding('foo', { plannerAvailable: false });
  assert.match(md, /No classifier output is available/);
  // Must not promise the LLM-augmented fields when they cannot be delivered.
  assert.doesNotMatch(md, /Read the classifier output:/);
});

test('scaffolding tells the agent to synthesize from raw URLs in degraded mode', () => {
  const md = buildStaticScaffolding('foo', { plannerAvailable: false });
  assert.match(md, /raw ranked URL list/);
  assert.match(md, /synthesize the terrain yourself/);
});
