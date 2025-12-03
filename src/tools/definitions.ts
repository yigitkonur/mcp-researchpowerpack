/**
 * MCP Tool Definitions
 * Extracted from index.ts for cleaner separation
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { deepResearchParamsSchema } from '../schemas/deep-research.js';
import { scrapeLinksParamsSchema } from '../schemas/scrape-links.js';
import { webSearchParamsSchema } from '../schemas/web-search.js';

export const TOOLS = [
  // === REDDIT TOOLS ===
  {
    name: 'search_reddit',
    description: `**Comprehensive Reddit research via Google (10 results/query, 10-50 queries supported).**

MUST call get_reddit_post after to fetch full post content and comments.

**QUERY REQUIREMENTS:**
- **Minimum:** 3 queries (hard limit)
- **Recommended:** 10+ queries (for meaningful consensus analysis)
- **Optimal:** 20-30 queries covering all angles of the topic
- **Maximum:** 50 queries (for comprehensive deep research)

**OUTPUT FORMAT:**
1. **High-Consensus Posts** - Posts appearing in multiple queries (ranked by CTR score)
2. **All Results (CTR-Ranked)** - Aggregated unique posts sorted by weighted score
3. **Per-Query Raw Results** - Complete results for each individual query before aggregation

**QUERY CRAFTING STRATEGY (aim for 10-50 distinct queries):**
- Direct topic variations (3-5 queries)
- Recommendation/best-of queries (3-5 queries)
- Specific tool/project names (5-10 queries)
- Comparison queries (3-5 queries)
- Alternative/replacement queries (3-5 queries)
- Subreddit-specific queries (5-10 queries)
- Problem/issue queries (3-5 queries)
- Year-specific queries for recency (2-3 queries)

**OPERATORS:** intitle:, "exact phrase", OR, -exclude. Auto-adds site:reddit.com.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: `**3-50 queries for Reddit research.** Minimum 3 required, but generate at least 10 for meaningful consensus. More queries = better consensus detection.

**QUERY CATEGORIES (aim for coverage across all):**

1. **Direct Topic (3-5):** "YouTube Music Mac app", "YTM desktop application"
2. **Recommendations (3-5):** "best YouTube Music client Mac", "recommended YTM app"
3. **Specific Tools (5-10):** "YTMDesktop Mac", "th-ch youtube-music", "steve228uk YT Music"
4. **Comparisons (3-5):** "YouTube Music vs Spotify Mac", "YTM vs Apple Music desktop"
5. **Alternatives (3-5):** "YouTube Music Mac alternative", "YTM replacement app"
6. **Subreddits (5-10):** "r/YoutubeMusic desktop", "r/macapps YouTube Music", "r/opensource YTM"
7. **Problems/Issues (3-5):** "YouTube Music desktop performance", "YTM app crashes Mac"
8. **Year-Specific (2-3):** "best YouTube Music app 2024", "YTM desktop 2025"
9. **Features (3-5):** "YouTube Music offline Mac", "YTM lyrics desktop"
10. **Developer/GitHub (3-5):** "youtube-music electron app", "YTM github project"`,
        },
        date_after: {
          type: 'string',
          description: 'Filter results after date (YYYY-MM-DD). Optional.',
        },
      },
      required: ['queries'],
    },
  },
  {
    name: 'get_reddit_post',
    description: `**Fetch Reddit posts with smart comment allocation (2-50 posts supported).**

**SMART COMMENT BUDGET:** 1,000 comments distributed across all posts automatically.
- 2 posts: ~500 comments/post (deep dive)
- 10 posts: 100 comments/post
- 50 posts: 20 comments/post (quick scan)

**PARAMETERS:**
- \`urls\`: 2-50 Reddit post URLs. More posts = broader community perspective.
- \`fetch_comments\`: Set to false for post-only queries (faster). Default: true.
- \`max_comments\`: Override auto-allocation if needed.

**USE:** After search_reddit. Maximize post count for research breadth. Comment allocation is automatic and optimized.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reddit URLs (2-50). More posts = broader community perspective.',
        },
        fetch_comments: {
          type: 'boolean',
          description: 'Fetch comments? Set false for quick post overview. Default: true',
          default: true,
        },
        max_comments: {
          type: 'number',
          description: 'Override auto-allocation. Leave empty for smart allocation.',
          default: 100,
        },
      },
      required: ['urls'],
    },
  },

  // === DEEP RESEARCH TOOL ===
  {
    name: 'deep_research',
    description: `**Batch deep research (2-10 questions) with dynamic token allocation.**

**TOKEN BUDGET:** 32,000 tokens distributed across all questions:
- 2 questions: 16,000 tokens/question (deep dive)
- 5 questions: 6,400 tokens/question (balanced)
- 10 questions: 3,200 tokens/question (rapid multi-topic)

**WHEN TO USE:**
- Need multi-perspective analysis on related topics
- Researching a domain from multiple angles
- Validating understanding across different aspects
- Comparing approaches/technologies side-by-side

**EACH QUESTION SHOULD INCLUDE:**
- Topic & context (what decision it informs)
- Your current understanding (to fill gaps)
- Specific sub-questions (2-5 per topic)

**USE:** Maximize question count for comprehensive coverage. All questions run in parallel. Group related questions for coherent research.`,
    inputSchema: zodToJsonSchema(deepResearchParamsSchema, { $refStrategy: 'none' }),
  },

  // === SCRAPE LINKS TOOL ===
  {
    name: 'scrape_links',
    description: `**Universal URL content extraction (3-50 URLs) with dynamic token allocation.**

**TOKEN ALLOCATION:** 32,000 tokens distributed across all URLs automatically.
- 3 URLs: ~10,666 tokens/URL (deep extraction)
- 10 URLs: 3,200 tokens/URL (detailed)
- 50 URLs: 640 tokens/URL (high-level scan)

**AUTOMATIC FALLBACK:** Basic → JavaScript → JavaScript+US geo-targeting.

**AI EXTRACTION:** Set use_llm=true with what_to_extract for intelligent filtering. Extraction is concise + comprehensive (high info density).

**BATCHING:** Max 30 concurrent requests. 50 URLs = [30] then [20] batches.

**USE:** Provide 3-50 URLs. More URLs = broader coverage, fewer tokens per URL. Choose based on research scope. Maximize URL count for comprehensive research.`,
    inputSchema: zodToJsonSchema(scrapeLinksParamsSchema, { $refStrategy: 'none' }),
  },

  // === WEB SEARCH TOOL ===
  {
    name: 'web_search',
    description: `**Batch web search** using Google via SERPER API. Search up to 100 keywords in parallel, get top 10 results per keyword with snippets, links, and related searches.

**FEATURES:**
- Supports Google search operators (site:, -exclusion, "exact phrase", filetype:)
- Returns clickable markdown links with snippets
- Provides related search suggestions
- Identifies frequently appearing URLs across queries

**USE:** For research tasks requiring multiple perspectives. Use distinct keywords to maximize coverage. Follow up with scrape_links to extract full content from promising URLs.`,
    inputSchema: zodToJsonSchema(webSearchParamsSchema, { $refStrategy: 'none' }),
  },
];
