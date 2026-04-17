import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeSuggestion } from '../src/utils/sanitize.js';

test('removes control characters, raw urls, and collapses markdown links', () => {
  const sanitized = sanitizeSuggestion(
    '  hello\x00 https://example.com [click me](https://bad.test)   world  ',
  );

  assert.equal(sanitized, 'hello click me world');
});

test('preserves full length — no artificial cap', () => {
  const sanitized = sanitizeSuggestion('x'.repeat(120));
  assert.equal(sanitized.length, 120);
});
