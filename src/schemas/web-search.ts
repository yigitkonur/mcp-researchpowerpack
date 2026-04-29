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
  // `content` deliberately NOT duplicated here — the primary markdown lives in
  // the MCP tool result's `content[0].text`. Previously this schema echoed the
  // whole markdown under `structuredContent.content`, doubling token cost for
  // clients that forward both fields to an LLM.
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
    query_rewrites: z
      .array(z.object({
        original: z.string().describe('The query as the agent submitted it.'),
        rewritten: z.string().describe('The query as dispatched to Google after Phase A normalization.'),
        rules: z.array(z.string()).describe('Rule ids applied (A1=operator-char de-quote, A2=path/URL de-quote, A3=phrase-AND collapse).'),
      }))
      .optional()
      .describe('Pre-dispatch query rewrites — Phase A normalizations (operator-char and path/URL de-quote, phrase-AND → anchor + OR collapse).'),
    retried_queries: z
      .array(z.object({
        original: z.string().describe('The query as dispatched (post-Phase-A) that returned 0 results.'),
        retried_with: z.string().describe('The relaxed form retried after the empty initial response.'),
        rules: z.array(z.string()).describe('Rule ids applied (B1=strip all quotes, B2=drop site: filter).'),
        recovered_results: z.number().int().nonnegative().describe('How many hits the retry produced; 0 means the retry also failed.'),
      }))
      .optional()
      .describe('On-empty retries — Phase B relaxations applied after the initial Serper batch returned 0 results for a query.'),
  }).strict(),
}).strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
