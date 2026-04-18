/**
 * Content Extractor — strips HTML chrome (cookie banners, nav, footer,
 * repeated hero blocks) before scraped pages reach the LLM extractor or the
 * raw fallback path. Both paths benefit equally — the cleaner the content,
 * the less LLM tokens are spent on noise and the less raw HTML the agent has
 * to reason around.
 *
 * Implementation: Mozilla Readability over jsdom. Falls back to the original
 * HTML if Readability cannot identify an article body — never throws.
 *
 * See: docs/code-review/context/02-current-tool-surface.md (E5) for the
 * baseline 12,704-char Merge blog probe; this module's acceptance bar is
 * <8,000 chars on the same input.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { mcpLog } from './logger.js';

export interface ExtractedContent {
  /** Page title — if Readability could identify one. */
  readonly title: string;
  /** Main article content (HTML, ready for HTML→Markdown conversion). */
  readonly content: string;
  /** Author byline if extractable. */
  readonly byline?: string;
  /** True if Readability ran successfully; false on fallback. */
  readonly extracted: boolean;
}

/** Maximum HTML length we attempt to feed jsdom. Larger pages are passed
 *  through unchanged — Readability + jsdom are O(n) but allocate a real DOM
 *  per call which can balloon RSS on a 5MB SPA bundle. */
const MAX_READABILITY_BYTES = 1_500_000 as const;

export function extractReadableContent(html: string, url?: string): ExtractedContent {
  if (!html || typeof html !== 'string') {
    return { title: '', content: html ?? '', extracted: false };
  }

  if (html.length > MAX_READABILITY_BYTES) {
    return { title: '', content: html, extracted: false };
  }

  // Quick heuristic — if there's no HTML structure, skip Readability entirely.
  if (!html.includes('<')) {
    return { title: '', content: html, extracted: false };
  }

  // jsdom emits noisy "could not parse CSS" / network errors on real pages.
  // Silence them so they do not pollute server-side stderr.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('warn', () => {});
  virtualConsole.on('jsdomError', () => {});

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, {
      url: url && /^https?:/i.test(url) ? url : 'https://example.com/',
      virtualConsole,
    });
  } catch (err) {
    mcpLog('warning', `JSDOM construction failed: ${err instanceof Error ? err.message : String(err)}`, 'content-extractor');
    return { title: '', content: html, extracted: false };
  }

  try {
    const reader = new Readability(dom.window.document, {
      // Keep classes that downstream cleanup may need; Turndown ignores them.
      keepClasses: false,
      // Strip <script>/<style> already handled by Readability defaults.
    });
    const article = reader.parse();
    if (!article || !article.content) {
      return { title: article?.title ?? '', content: html, extracted: false };
    }
    return {
      title: article.title ?? '',
      content: article.content,
      byline: article.byline ?? undefined,
      extracted: true,
    };
  } catch (err) {
    mcpLog('warning', `Readability.parse failed: ${err instanceof Error ? err.message : String(err)}`, 'content-extractor');
    return { title: '', content: html, extracted: false };
  } finally {
    // jsdom retains references via global refs — close the window to free RSS.
    try { dom.window.close(); } catch { /* ignore */ }
  }
}
