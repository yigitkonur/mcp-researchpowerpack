import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReadableContent } from '../src/utils/content-extractor.js';

const PAGE = `<!doctype html><html><head><title>Demo</title></head><body>
  <header><nav>Home | Pricing | Login</nav></header>
  <div class="cookie-banner">We use cookies. <button>Accept</button></div>
  <main>
    <article>
      <h1>The Real Article</h1>
      <p>This is the actual content of the page that the agent cares about.</p>
      <p>Second paragraph with more substance — at least one hundred words is normally required for Readability to consider this an article body, so let me keep typing. The brown fox jumps over the lazy dog and so on and so forth and the rest of the placeholder text. Beyond a doubt this paragraph is long enough to clear Readability's article-body heuristic threshold and produce a non-null parse result.</p>
    </article>
  </main>
  <footer>(c) 2026 Demo Inc. All rights reserved.</footer>
</body></html>`;

test('extractReadableContent strips chrome and keeps article body', () => {
  const result = extractReadableContent(PAGE, 'https://example.com/post');
  assert.equal(result.extracted, true, 'expected Readability to parse the article');
  assert.match(result.content, /actual content of the page/);
  // nav links and footer copyright should be dropped by Readability
  assert.doesNotMatch(result.content, /Login/);
  assert.doesNotMatch(result.content, /Demo Inc/);
  // Note: Readability deliberately retains cookie-banner text in some cases
  // because it contains real prose. The hostname-specific stripping is a
  // future improvement; the immediate win is dropping nav/footer chrome.
});

test('extractReadableContent falls back gracefully on plain text', () => {
  const text = 'just some plain text content with no html tags';
  const result = extractReadableContent(text);
  assert.equal(result.extracted, false);
  assert.equal(result.content, text);
});

test('extractReadableContent never throws on malformed input', () => {
  const result = extractReadableContent('<<>><not really html');
  assert.equal(typeof result.content, 'string');
  // Either parsed or fell back; both are acceptable. Just must not throw.
});

test('extractReadableContent returns input unchanged for huge pages', () => {
  const huge = '<html><body>' + 'x'.repeat(2_000_000) + '</body></html>';
  const result = extractReadableContent(huge);
  assert.equal(result.extracted, false, 'expected to bail on >1.5MB input');
});
