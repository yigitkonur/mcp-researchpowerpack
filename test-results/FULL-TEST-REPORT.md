# MCP Research Powerpack - Full Test Report

**Date:** 2026-01-31
**Version:** 3.4.6
**Inspector Version:** 0.14.3 (via npx)
**Test Method:** MCP Inspector CLI with `--config` approach

---

## Test Summary

| # | Test | Tool | Status | Notes |
|---|------|------|--------|-------|
| 1 | tools/list | all | PASS | All 5 tools registered correctly |
| 2 | web_search (3 keywords) | web_search | PASS | 30 results, consensus scoring works |
| 3 | search_reddit (10 queries) | search_reddit | PASS | 98 unique posts, 10 queries |
| 4 | scrape_links (no LLM) | scrape_links | PASS | 2 URLs, clean markdown |
| 5 | scrape_links (with LLM) | scrape_links | PASS | HN extraction with structured tables |
| 6 | deep_research (2 questions) | deep_research | PASS | Parallel research, token allocation |
| 7 | get_reddit_post (with comments) | get_reddit_post | PASS | 2 posts, 15-19 comments each |
| 8 | get_reddit_post (with LLM) | get_reddit_post | PASS | AI analysis with synthesis |
| 9 | web_search validation (<3 keywords) | web_search | PASS | Correct rejection |
| 10 | search_reddit validation (<10 queries) | search_reddit | PASS | Correct rejection |
| 11 | scrape_links (invalid URL) | scrape_links | PASS | Graceful degradation (1 ok, 1 fail) |
| 12 | deep_research (short question) | deep_research | PASS | Correct validation error |
| 13 | Nonexistent tool | - | PASS | McpError with available tools list |
| 14 | search_reddit (date_after filter) | search_reddit | PASS | 84 unique posts with date filtering |
| 15 | get_reddit_post (no comments) | get_reddit_post | PASS | Comments not fetched message shown |
| 16 | deep_research (file attachment) | deep_research | PASS | File read and analyzed correctly |

**Result: 16/16 tests PASS**

---

## Bugs Found & Fixed

### BUG-1: `{#}` placeholder in web_search validation error (FIXED)

**File:** `src/schemas/web-search.ts:19`
**Severity:** Low (cosmetic)
**Description:** Zod `.min()` does not support `{#}` template variables in error messages. The validation error message displayed literal `{#}` instead of actual counts.

**Before:**
```
web_search: MINIMUM 3 keywords required. You provided {#}. Add {#} more diverse keywords covering different perspectives.
```

**After:**
```
web_search: MINIMUM 3 keywords required. Add more diverse keywords covering different perspectives.
```

---

## Code Quality Observations

### 1. Inconsistent Schema Location (Minor)

`search_reddit` and `get_reddit_post` have inline schemas in `src/tools/registry.ts` (lines 57-68), while the other 3 tools have dedicated schema files in `src/schemas/`. The inline schemas also lack the detailed validation messages that the external schemas provide.

**registry.ts inline schemas (sparse):**
```ts
const searchRedditParamsSchema = z.object({
  queries: z.array(z.string()).min(10).max(50),
  date_after: z.string().optional(),
});
```

**web-search.ts external schema (rich):**
```ts
.min(3, { message: 'web_search: MINIMUM 3 keywords required...' })
.max(100, { message: 'web_search: Maximum 100 keywords allowed...' })
```

### 2. Error Handling Architecture (Excellent)

All tools follow the "NEVER throws" pattern consistently:
- Handlers catch all errors internally
- Return structured error responses instead of throwing
- Graceful degradation on partial failures (e.g., 1 of 2 URLs failing)
- Safe logger wrappers that never crash the tool
- Classified errors with retryable flags

### 3. Token Budget System (Working)

Dynamic token allocation works correctly:
- 32,000 total budget divided by URL/question count
- Headers correctly show allocation in output
- Budget displayed in all tool responses

### 4. LLM Processing (Working)

Both `scrape_links` and `get_reddit_post` correctly support `use_llm=true`:
- Falls back gracefully when OPENROUTER_API_KEY is missing
- Per-URL token allocation
- Enhanced extraction with custom instructions

### 5. Retry Logic (Robust)

- Exponential backoff with jitter in search client
- Rate limit detection (429) in Reddit client
- Configurable retry counts and delays
- Module-level OAuth token cache with 60s buffer

---

## Test Artifacts

All test outputs saved to: `test-results/`
- `02-web-search.txt` through `16-deep-research-file-attach.txt`
