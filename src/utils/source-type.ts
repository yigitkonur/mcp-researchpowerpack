/**
 * Hostname/path-heuristic source-type tagging. Works without the LLM
 * classifier so degraded-mode web-search responses still carry a
 * `source_type` field per result. When the LLM classifier IS available,
 * its tag wins (the classifier sees title + snippet as well, not just URL).
 *
 * See: mcp-revisions/output-shaping/06-source-type-tagging-without-llm.md.
 */

export type SourceType =
  | 'reddit'
  | 'github'
  | 'docs'
  | 'blog'
  | 'paper'
  | 'qa'
  | 'cve'
  | 'news'
  | 'video'
  | 'web';

const RULES: Array<[RegExp, SourceType]> = [
  // Reddit post permalinks (subreddit homepages are filtered out upstream).
  [/(?:^|\.)reddit\.com\//i, 'reddit'],
  [/(?:^|\.)github\.com\//i, 'github'],
  [/(?:^|\.)gitlab\.com\//i, 'github'],
  // CVE-prefixed paths are unambiguous regardless of host.
  [/\/CVE-\d{4}-\d+/i, 'cve'],
  [/(?:^|\.)nvd\.nist\.gov\//i, 'cve'],
  [/(?:^|\.)stackoverflow\.com\//i, 'qa'],
  [/(?:^|\.)stackexchange\.com\//i, 'qa'],
  [/(?:^|\.)arxiv\.org\//i, 'paper'],
  [/(?:^|\.)medium\.com\//i, 'blog'],
  [/(?:^|\.)dev\.to\//i, 'blog'],
  [/(?:^|\.)substack\.com\//i, 'blog'],
  // Docs subdomains and /docs/ paths.
  [/^(?:[a-z0-9-]+\.)*docs\./i, 'docs'],
  [/\/docs\//i, 'docs'],
  [/(?:^|\.)readthedocs\.io\//i, 'docs'],
  // Video.
  [/(?:^|\.)youtube\.com\/watch/i, 'video'],
  [/(?:^|\.)youtu\.be\//i, 'video'],
  // News / engineering blogs (last so it doesn't capture vendor docs).
  [/(?:^|\.)(?:news|blog|engineering)\.[a-z0-9-]+\.[a-z]{2,}\//i, 'news'],
];

export function classifySourceByUrl(url: string): SourceType {
  let candidate: string;
  try {
    const u = new URL(url);
    // Match against `host + pathname` so rules can use either or both.
    candidate = `${u.hostname}${u.pathname}`;
  } catch {
    candidate = url;
  }
  for (const [re, type] of RULES) {
    if (re.test(candidate)) return type;
  }
  return 'web';
}

// ── Document-format detection (PDF / Office) ───────────────────────────────
// Scrape.do + Readability + Turndown assume HTML input. Binary document
// formats need a markdown-extraction service (Jina Reader) instead. These two
// helpers give the scrape pipeline both a pre-fetch gate (URL suffix) and a
// post-fetch gate (response Content-Type header).

const DOCUMENT_PATH_SUFFIXES = [
  '.pdf',
  '.doc', '.docx',
  '.ppt', '.pptx',
  '.xls', '.xlsx',
] as const;

/**
 * Pre-fetch gate: does this URL's path end in a known binary-document suffix?
 * Case-insensitive. Trailing query strings / fragments are ignored — only the
 * pathname is inspected. Invalid URLs return false (handled upstream).
 */
export function isDocumentUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  for (const suffix of DOCUMENT_PATH_SUFFIXES) {
    if (pathname.endsWith(suffix)) return true;
  }
  return false;
}

const BINARY_CONTENT_TYPE_PREFIXES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/octet-stream',
] as const;

/**
 * Post-fetch gate: does this Content-Type header indicate a binary document
 * that our HTML pipeline cannot decode? Returns false for HTML/JSON/plain text
 * and for unknown/missing content-types (the upstream pipeline can still try).
 */
export function isBinaryDocumentContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  for (const prefix of BINARY_CONTENT_TYPE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}
