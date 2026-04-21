import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLANNER_FAILURE_THRESHOLD,
  PLANNER_FAILURE_TTL_MS,
  isPlannerKnownOffline,
} from '../src/tools/start-research.js';
import {
  _resetLLMHealthForTests,
  getLLMHealth,
  markLLMFailure,
  markLLMSuccess,
} from '../src/services/llm-processor.js';

// Fixed clock so the TTL math is deterministic regardless of CI speed.
const NOW = Date.parse('2026-04-21T17:30:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function healthAt(overrides: {
  plannerConfigured?: boolean;
  consecutivePlannerFailures?: number;
  lastPlannerCheckedAt?: string | null;
}): Parameters<typeof isPlannerKnownOffline>[0] {
  return {
    plannerConfigured: overrides.plannerConfigured ?? true,
    consecutivePlannerFailures: overrides.consecutivePlannerFailures ?? 0,
    lastPlannerCheckedAt: overrides.lastPlannerCheckedAt ?? null,
  };
}

test('gate: not configured → offline (hard stop, ignores counter + TTL)', () => {
  assert.equal(isPlannerKnownOffline(healthAt({ plannerConfigured: false }), NOW), true);
  // Even with 0 failures and a fresh timestamp, no config means offline.
  assert.equal(
    isPlannerKnownOffline(
      healthAt({ plannerConfigured: false, consecutivePlannerFailures: 0, lastPlannerCheckedAt: at(0) }),
      NOW,
    ),
    true,
  );
});

test('gate: configured + never probed → online', () => {
  assert.equal(
    isPlannerKnownOffline(
      healthAt({ plannerConfigured: true, consecutivePlannerFailures: 0, lastPlannerCheckedAt: null }),
      NOW,
    ),
    false,
  );
});

test('gate: single recent failure is tolerated (below threshold)', () => {
  assert.equal(
    isPlannerKnownOffline(
      healthAt({ consecutivePlannerFailures: 1, lastPlannerCheckedAt: at(-1000) }),
      NOW,
    ),
    false,
  );
});

test('gate: threshold (2) recent failures → offline', () => {
  assert.equal(
    isPlannerKnownOffline(
      healthAt({
        consecutivePlannerFailures: PLANNER_FAILURE_THRESHOLD,
        lastPlannerCheckedAt: at(-5_000),
      }),
      NOW,
    ),
    true,
  );
});

test('gate: threshold met but failure is stale (>TTL) → online (give it another chance)', () => {
  assert.equal(
    isPlannerKnownOffline(
      healthAt({
        consecutivePlannerFailures: 5,
        lastPlannerCheckedAt: at(-(PLANNER_FAILURE_TTL_MS + 1_000)),
      }),
      NOW,
    ),
    false,
  );
});

test('gate: at exactly TTL boundary → online (strict less-than)', () => {
  // nowMs - lastMs === TTL  →  NOT gated (strict `< TTL`).
  assert.equal(
    isPlannerKnownOffline(
      healthAt({
        consecutivePlannerFailures: 3,
        lastPlannerCheckedAt: at(-PLANNER_FAILURE_TTL_MS),
      }),
      NOW,
    ),
    false,
  );
  // One ms inside the window  →  gated.
  assert.equal(
    isPlannerKnownOffline(
      healthAt({
        consecutivePlannerFailures: 3,
        lastPlannerCheckedAt: at(-(PLANNER_FAILURE_TTL_MS - 1)),
      }),
      NOW,
    ),
    true,
  );
});

test('gate: malformed lastPlannerCheckedAt → online (defensive)', () => {
  assert.equal(
    isPlannerKnownOffline(
      healthAt({
        consecutivePlannerFailures: 5,
        lastPlannerCheckedAt: 'not-a-real-iso-date',
      }),
      NOW,
    ),
    false,
  );
});

test('gate: future timestamp (clock skew) → offline (conservative — still within TTL)', () => {
  // If the server records a timestamp slightly in the future relative to nowMs,
  // nowMs - lastMs is negative, which is < TTL, so we stay gated. That's the
  // conservative choice — prefer a stub over a broken LLM call during clock skew.
  assert.equal(
    isPlannerKnownOffline(
      healthAt({
        consecutivePlannerFailures: PLANNER_FAILURE_THRESHOLD,
        lastPlannerCheckedAt: at(5_000),
      }),
      NOW,
    ),
    true,
  );
});

test('gate: zero failures with a stamped timestamp (post-success state) → online', () => {
  // After markLLMSuccess, counter is 0 but lastPlannerCheckedAt is set. Must NOT gate.
  assert.equal(
    isPlannerKnownOffline(
      healthAt({ consecutivePlannerFailures: 0, lastPlannerCheckedAt: at(-10) }),
      NOW,
    ),
    false,
  );
});

test('gate: constants are sane (threshold ≥ 2, TTL between 10s and 10min)', () => {
  assert.ok(PLANNER_FAILURE_THRESHOLD >= 2, 'need at least 2 to tolerate a single blip');
  assert.ok(PLANNER_FAILURE_TTL_MS >= 10_000, 'TTL must be long enough to absorb a burst');
  assert.ok(PLANNER_FAILURE_TTL_MS <= 10 * 60_000, 'TTL must not exceed 10 minutes');
});

// ----------------------------------------------------------------------------
// End-to-end: mark* primitives + getLLMHealth + isPlannerKnownOffline all wired.
// Uses real clock, but every assertion is against the current snapshot with
// `Date.now()` so there is no flakiness window.
// ----------------------------------------------------------------------------

test('e2e: a single failure does NOT close the gate (regression for the deadlock)', () => {
  _resetLLMHealthForTests();
  markLLMFailure('planner', 'one transient parse error');
  // Only a `plannerConfigured:false` here would gate us; if the env is present
  // we assert the counter-based gate stays open. Either way, it must NOT behave
  // like the old sticky semantics (which would gate on ANY prior failure).
  const h = getLLMHealth();
  if (h.plannerConfigured) {
    assert.equal(isPlannerKnownOffline(h), false, 'single failure must not gate when configured');
  }
});

test('e2e: threshold consecutive failures close the gate when configured', () => {
  _resetLLMHealthForTests();
  for (let i = 0; i < PLANNER_FAILURE_THRESHOLD; i += 1) {
    markLLMFailure('planner', `failure ${i}`);
  }
  const h = getLLMHealth();
  if (h.plannerConfigured) {
    assert.equal(isPlannerKnownOffline(h), true, 'threshold failures within TTL must gate');
  }
});

test('e2e: a success after threshold failures immediately re-opens the gate', () => {
  _resetLLMHealthForTests();
  for (let i = 0; i < PLANNER_FAILURE_THRESHOLD + 2; i += 1) {
    markLLMFailure('planner', `burst ${i}`);
  }
  markLLMSuccess('planner');
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 0);
  if (h.plannerConfigured) {
    assert.equal(isPlannerKnownOffline(h), false, 'success must reset the counter and open the gate');
  }
});

test('e2e: extractor failures do NOT affect the planner gate', () => {
  _resetLLMHealthForTests();
  for (let i = 0; i < PLANNER_FAILURE_THRESHOLD + 3; i += 1) {
    markLLMFailure('extractor', `e${i}`);
  }
  const h = getLLMHealth();
  assert.equal(h.consecutivePlannerFailures, 0);
  if (h.plannerConfigured) {
    assert.equal(isPlannerKnownOffline(h), false);
  }
});
