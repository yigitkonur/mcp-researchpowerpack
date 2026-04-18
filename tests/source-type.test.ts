import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySourceByUrl } from '../src/utils/source-type.js';

const FIXTURES: Array<[string, ReturnType<typeof classifySourceByUrl>]> = [
  ['https://reddit.com/r/foo/comments/abc/post', 'reddit'],
  ['https://www.reddit.com/r/foo/', 'reddit'],
  ['https://old.reddit.com/r/x/comments/y/z', 'reddit'],
  ['https://github.com/anthropics/claude-code', 'github'],
  ['https://gitlab.com/some/repo', 'github'],
  ['https://docs.anthropic.com/en/api', 'docs'],
  ['https://example.com/docs/getting-started', 'docs'],
  ['https://readthedocs.io/projects/foo/', 'docs'],
  ['https://medium.com/@foo/bar', 'blog'],
  ['https://dev.to/article', 'blog'],
  ['https://substack.com/p/foo', 'blog'],
  ['https://arxiv.org/abs/1234.5678', 'paper'],
  ['https://stackoverflow.com/questions/1', 'qa'],
  ['https://stackexchange.com/questions/1', 'qa'],
  ['https://nvd.nist.gov/vuln/detail/CVE-2024-12345', 'cve'],
  ['https://example.com/security/CVE-2025-1', 'cve'],
  ['https://youtube.com/watch?v=abc', 'video'],
  ['https://youtu.be/abc', 'video'],
  ['https://news.ycombinator.com/item?id=1', 'news'],
  ['https://blog.cloudflare.com/post', 'news'],
  ['https://engineering.fb.com/post', 'news'],
  ['https://example.com/some-page', 'web'],
];

for (const [url, expected] of FIXTURES) {
  test(`classifySourceByUrl: ${url} → ${expected}`, () => {
    assert.equal(classifySourceByUrl(url), expected);
  });
}

test('unknown URL falls back to "web"', () => {
  assert.equal(classifySourceByUrl('not-a-url'), 'web');
});
