import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDegradedStub, buildStaticScaffolding } from '../src/tools/start-research.js';

test('degraded stub is dramatically shorter than full playbook', () => {
  const stub = buildDegradedStub('compare X to Y');
  const playbook = buildStaticScaffolding('compare X to Y');
  // Stub should be roughly under 1500 chars (~375 tokens) vs ~4400 chars for the playbook.
  assert.ok(stub.length < 1500, `expected stub <1500 chars, got ${stub.length}`);
  assert.ok(playbook.length > 3000, `expected playbook >3000 chars, got ${playbook.length}`);
  // Stub mentions the loop and the include_playbook escape hatch.
  assert.match(stub, /search → scrape → verify → stop/);
  assert.match(stub, /include_playbook/);
});

test('degraded stub admits the planner-offline state up-front', () => {
  const stub = buildDegradedStub();
  assert.match(stub, /LLM planner offline/);
});

test('degraded stub names Reddit branch rule succinctly', () => {
  const stub = buildDegradedStub();
  assert.match(stub, /Reddit branch:/);
  assert.match(stub, /sentiment|migration|lived experience/);
});

test('degraded stub uses focus line when goal is provided', () => {
  const stub = buildDegradedStub('investigate auth flows');
  assert.match(stub, /Focus for this session: investigate auth flows/);
});

test('both stub and full playbook surface the run-research skill install hint', () => {
  const stub = buildDegradedStub();
  const playbook = buildStaticScaffolding();
  for (const out of [stub, playbook]) {
    assert.match(out, /run-research/, 'expected skill name in install hint');
    assert.match(out, /npx -y skills add/);
    assert.match(out, /yigitkonur\/skills-by-yigitkonur\/skills\/run-research/);
  }
});
