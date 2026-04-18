import { z } from 'zod';

export const webSearchParamsSchema = z.object({
  queries: z
    .array(
      z.string()
        .min(1, { message: 'web-search: Query cannot be empty' })
        .describe('A single Google search query. Each query runs as a separate parallel search. Use operators (site:, quotes, verbatim version numbers) to sharpen retrieval.'),
    )
    .min(1, { message: 'web-search: At least 1 query required' })
    .describe(
      'Search queries to run in parallel via Google. Think of these as **concept groups** — clusters of semantically distinct facets of your research goal, each probing a DIFFERENT angle (official spec, implementation, failures, comparison, sentiment, changelog, CVE, pricing). Fire all groups in ONE call as a flat array. Overlapping queries waste budget; orthogonal facets multiply coverage. A narrow bug needs 10–20 queries across 2–3 facets; a comparison needs 25–35 across 4–6 facets; open-ended synthesis needs 40–80 across 8+ facets.',
    ),
  extract: z
    .string()
    .min(1, { message: 'web-search: extract cannot be empty' })
    .describe(
      'Semantic instruction for the relevance classifier — what "relevant" means for THIS goal. Drives tiering (HIGHLY_RELEVANT / MAYBE_RELEVANT / OTHER), synthesis, gap analysis, and refine-query suggestions. Be specific: "OAuth 2.1 support in TypeScript MCP frameworks — runnable code, not marketing", not "MCP OAuth". The classifier uses this to choose a source-of-truth rubric (vendor_doc for spec, github for bugs, reddit/blog for migration/sentiment, cve_databases for security).',
    ),
  raw: z
    .boolean()
    .default(false)
    .describe('Skip LLM classification and return the raw ranked URL list. Use when you need unprocessed results.'),
  scope: z
    .enum(['web', 'reddit', 'both'])
    .default('web')
    .describe(
      'Search scope. "web" (default) = open web, no augmentation. "reddit" = server appends `site:reddit.com` to every query and filters results to post permalinks (`/r/.+/comments/[a-z0-9]+/`); subreddit homepages are dropped. "both" = runs every query twice (open web + reddit-scoped), merges the result set, and tags each row with its source. Use "reddit" for sentiment/migration/lived-experience research; use "both" when you want one call to cover both branches.',
    ),
  verbose: z
    .boolean()
    .default(false)
    .describe(
      'Include the per-row scoring/coverage metadata, the trailing Signals block, and the CONSENSUS labels even when they carry little signal (single-query hits, threshold of 1). Default false — most agents do not need this and it costs ~1.5KB per call on a typical 3-query fan-out.',
    ),
}).strict();

export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;

export const webSearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Markdown report with tiered results (LLM mode) or ranked URL list (raw mode).'),
  results: z
    .array(z.object({
      rank: z.number().int().positive().describe('1-based rank in the merged ranking.'),
      url: z.string().describe('Result URL.'),
      title: z.string().describe('Page title from the result.'),
      snippet: z.string().describe('Search snippet from the result.'),
      source_type: z
        .enum(['reddit', 'github', 'docs', 'blog', 'paper', 'qa', 'cve', 'news', 'video', 'web'])
        .describe(
          'Heuristic source kind from the URL. When the LLM classifier is online its tag overrides this.',
        ),
      score: z.number().describe('Composite CTR-weighted score, normalized to 100.'),
      seen_in: z.number().int().nonnegative().describe('Number of input queries this URL appeared in.'),
      best_position: z.number().int().nonnegative().describe('Best (lowest) SERP position observed.'),
    }))
    .optional()
    .describe('Per-result structured payload — same data the markdown table renders, machine-readable.'),
  metadata: z.object({
    total_items: z.number().int().nonnegative().describe('Number of queries executed.'),
    successful: z.number().int().nonnegative().describe('Queries that returned results.'),
    failed: z.number().int().nonnegative().describe('Queries that failed.'),
    execution_time_ms: z.number().int().nonnegative().describe('Wall clock time in milliseconds.'),
    llm_classified: z.boolean().describe('Whether LLM classification was applied.'),
    llm_error: z.string().optional().describe('LLM error if classification failed and fell back to raw.'),
    scope: z.enum(['web', 'reddit', 'both']).optional().describe('Search scope used.'),
    coverage_summary: z
      .array(z.object({
        query: z.string().describe('The search query.'),
        result_count: z.number().int().nonnegative().describe('Results returned for this query.'),
        top_url: z.string().optional().describe('Domain of the top result.'),
      }))
      .optional()
      .describe('Per-query result counts and top URLs.'),
    low_yield_queries: z
      .array(z.string())
      .optional()
      .describe('Queries that produced 0-1 results.'),
  }).strict(),
}).strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
