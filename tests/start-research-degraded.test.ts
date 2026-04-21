import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDegradedStub, buildStaticScaffolding } from '../src/tools/start-research.js';

test('degraded stub is dramatically shorter than full playbook', () => {
  const stub = buildDegradedStub('compare X to Y');
  const playbook = buildStaticScaffolding('compare X to Y');

  assert.ok(stub.length < 2000, `expected stub <2000 chars, got ${stub.length}`);
  assert.ok(playbook.length > 2500, `expected playbook >2500 chars, got ${playbook.length}`);
  assert.ok(playbook.length > stub.length * 1.5, `playbook should be >=1.5x longer than stub (playbook=${playbook.length}, stub=${stub.length})`);
  assert.match(stub, /include_playbook/);
});

test('degraded stub admits the planner-offline state up-front', () => {
  const stub = buildDegradedStub();
  assert.match(stub, /LLM planner offline/);
});

test('degraded stub names all 3 tools', () => {
  const stub = buildDegradedStub();
  assert.match(stub, /`start-research`/);
  assert.match(stub, /`web-search`/);
  assert.match(stub, /`scrape-links`/);
});

test('degraded stub names the loop and Reddit-branch rule', () => {
  const stub = buildDegradedStub();
  assert.match(stub, /Loop/i);
  assert.match(stub, /Reddit branch/i);
  assert.match(stub, /sentiment|migration|lived experience/i);
});

test('degraded stub teaches parallel-callability', () => {
  const stub = buildDegradedStub();
  assert.match(stub, /parallel/i);
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
