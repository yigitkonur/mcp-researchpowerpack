import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetLLMHealthForTests,
  getLLMHealth,
  markLLMFailure,
  markLLMSuccess,
} from '../src/services/llm-processor.js';

test('getLLMHealth defaults: both paths report not-yet-checked', () => {
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  assert.equal(h.lastPlannerOk, false);
  assert.equal(h.lastExtractorOk, false);
  assert.equal(h.lastPlannerCheckedAt, null);
  assert.equal(h.lastExtractorCheckedAt, null);
  assert.equal(h.lastPlannerError, null);
  assert.equal(h.lastExtractorError, null);
});

test('markLLMSuccess flips planner ok and stamps checkedAt', () => {
  _resetLLMHealthForTests();
  markLLMSuccess('planner');
  const h = getLLMHealth();
  assert.equal(h.lastPlannerOk, true);
  assert.equal(h.lastExtractorOk, false);
  assert.ok(h.lastPlannerCheckedAt && h.lastPlannerCheckedAt.includes('T'));
  assert.equal(h.lastPlannerError, null);
});

test('markLLMFailure flips path off and records error message', () => {
  _resetLLMHealthForTests();
  markLLMSuccess('extractor');
  markLLMFailure('extractor', new Error('Connection refused'));
  const h = getLLMHealth();
  assert.equal(h.lastExtractorOk, false);
  assert.equal(h.lastExtractorError, 'Connection refused');
  assert.ok(h.lastExtractorCheckedAt);
});

test('planner and extractor health are independent', () => {
  _resetLLMHealthForTests();
  markLLMSuccess('planner');
  markLLMFailure('extractor', 'timeout');
  const h = getLLMHealth();
  assert.equal(h.lastPlannerOk, true);
  assert.equal(h.lastExtractorOk, false);
  assert.equal(h.lastPlannerError, null);
  assert.equal(h.lastExtractorError, 'timeout');
});

test('plannerConfigured / extractorConfigured reflect env capability', () => {
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  // Field is present and boolean regardless of env at test time.
  assert.equal(typeof h.plannerConfigured, 'boolean');
  assert.equal(typeof h.extractorConfigured, 'boolean');
});

test('consecutive-failure counters start at 0', () => {
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 0);
  assert.equal(h.consecutiveExtractorFailures, 0);
});

test('markLLMFailure increments the matching consecutive counter', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'first blip');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 1);
  markLLMFailure('planner', 'second blip');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 2);
  markLLMFailure('planner', 'third blip');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 3);
  // Extractor counter is untouched.
  assert.equal(getLLMHealth().consecutiveExtractorFailures, 0);
});

test('markLLMSuccess resets the matching consecutive counter to 0', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'a');
  markLLMFailure('planner', 'b');
  markLLMFailure('planner', 'c');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 3);
  markLLMSuccess('planner');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 0);
  // A subsequent failure starts the count over at 1, not from the old value.
  markLLMFailure('planner', 'd');
  assert.equal(getLLMHealth().consecutivePlannerFailures, 1);
});

test('planner and extractor counters are independent', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'p1');
  markLLMFailure('planner', 'p2');
  markLLMFailure('extractor', 'e1');
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 2);
  assert.equal(h.consecutiveExtractorFailures, 1);
  // Succeeding one does not affect the other.
  markLLMSuccess('extractor');
  const h2 = getLLMHealth();
  assert.equal(h2.consecutivePlannerFailures, 2);
  assert.equal(h2.consecutiveExtractorFailures, 0);
});

test('_resetLLMHealthForTests zeroes the counters', () => {
  markLLMFailure('planner', 'x');
  markLLMFailure('extractor', 'y');
  _resetLLMHealthForTests();
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 0);
  assert.equal(h.consecutiveExtractorFailures, 0);
});
