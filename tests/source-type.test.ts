import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySourceByUrl,
  isDocumentUrl,
  isBinaryDocumentContentType,
} from '../src/utils/source-type.js';

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

// ── isDocumentUrl ──────────────────────────────────────────────────────────

const DOCUMENT_URL_FIXTURES: Array<[string, boolean]> = [
  ['https://myk.gov.tr/images/articles/strateji/beklentiler_raporu/MYK_2024_MaliDurum_Beklentiler_Raporu.pdf', true],
  ['https://www.meb.gov.tr/meb_iys_dosyalar/2026_01/30122345_Kalfalik_Ustalik_ve_Usta_Ogreticilik_e-Sinav_Kilavuzu_2026.pdf', true],
  ['https://example.com/file.PDF', true],            // case-insensitive
  ['https://example.com/report.docx', true],
  ['https://example.com/slides.pptx', true],
  ['https://example.com/sheet.xlsx', true],
  ['https://example.com/legacy.doc', true],
  ['https://example.com/legacy.ppt', true],
  ['https://example.com/legacy.xls', true],
  ['https://example.com/file.pdf?download=1', true], // query string ignored
  ['https://example.com/file.pdf#page=3', true],     // fragment ignored
  ['https://example.com/index.html', false],
  ['https://example.com/', false],
  ['https://example.com/some-path', false],
  ['https://www.reddit.com/r/x/comments/y/z', false],
  ['not-a-url', false],
  ['', false],
];

for (const [url, expected] of DOCUMENT_URL_FIXTURES) {
  test(`isDocumentUrl: ${url.slice(0, 60) || '<empty>'} → ${expected}`, () => {
    assert.equal(isDocumentUrl(url), expected);
  });
}

// ── isBinaryDocumentContentType ────────────────────────────────────────────

const CONTENT_TYPE_FIXTURES: Array<[string | null | undefined, boolean]> = [
  ['application/pdf', true],
  ['application/pdf; charset=binary', true],
  ['APPLICATION/PDF', true],
  ['application/msword', true],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', true],
  ['application/vnd.ms-excel', true],
  ['application/vnd.ms-powerpoint', true],
  ['application/octet-stream', true],
  ['text/html', false],
  ['text/html; charset=utf-8', false],
  ['application/json', false],
  ['text/plain', false],
  ['', false],
  [null, false],
  [undefined, false],
];

for (const [header, expected] of CONTENT_TYPE_FIXTURES) {
  test(`isBinaryDocumentContentType: ${header ?? '<null>'} → ${expected}`, () => {
    assert.equal(isBinaryDocumentContentType(header), expected);
  });
}
