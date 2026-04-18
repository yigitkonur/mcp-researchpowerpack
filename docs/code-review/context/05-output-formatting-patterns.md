# Output Formatting Patterns

## Purpose

Show that output formatting in this server is **distributed across per-tool handlers, not centralized**. This is why the output-shaping work-units each touch multiple files rather than landing in one shared formatter. Read this before picking up any `mcp-revisions/output-shaping/*` unit.

## The shared layer (thin)

`src/utils/response.ts` exposes four helpers used across tools:

| Helper | Purpose |
|---|---|
| `formatError(ctx, message, details?)` | Structured error envelope (still returned via `text()` today — see the anti-pattern call-out below). |
| `formatSuccess(ctx, payload, meta?)` | Success envelope + optional metadata block. |
| `formatBatchHeader(total, successful, failed, durationMs)` | The `Successful: X / Failed: Y` header seen on `scrape-links` and `get-reddit-post`. |
| `formatDuration(ms)` | Human-friendly duration formatter. |

Every tool imports these — but each tool **also builds its own per-URL body, per-query section, and per-tool "Next Steps" footer**. There is no single function that owns "the shape of a tool response."

## The distributed layer (thick)

### `web-search` (`src/tools/search.ts`)

- `buildClassifiedOutput(...)` — tier headers + URL rows. Runs regardless of classifier success; when LLM is off, tiers are empty and only the ranked list survives.
- `buildSignalsSection(...)` — emits the "Signals" block appended to the end of the body. Present even when empty.
- `buildSuggestedFollowUpsSection(...)` — the Next Steps block with the literal `[...]` placeholders observed in probe output.
- `src/utils/url-aggregator.ts` owns the per-row metadata header: `Score: X | Seen in: Y/N queries (P%) | Best pos: #K | Consistency: ...` and the `CONSENSUS` label. The label fires whenever `seenInCount >= CONSENSUS_THRESHOLD`; threshold is set to `1` in the current deploy, which is why every row gets the label.

### `scrape-links` (`src/tools/scrape.ts`)

- Per-URL Markdown section built inline in the handler. Runs `MarkdownCleaner` on raw HTML; when `processContentWithLLM` fails, the cleaned-but-not-extracted Markdown is what reaches the client.
- Next Steps footer built inline at the bottom of the handler, not via `response.ts`.
- Header `Tokens/item: ~X` and `LLM extraction failures: Y` composed inline.

### `reddit.ts` (both `search-reddit` and `get-reddit-post`)

- Per-URL formatting for `get-reddit-post` built inline; includes the `⚠️ LLM unavailable` banner when `processContentWithLLM` is unreachable.
- Next Steps footer built inline with the `verify claims from Reddit` / `scrape URLs referenced in comments` templates observed in probe.
- `search-reddit` reuses classifier output paths similar to `web-search` but never runs through `url-aggregator.ts`, which is why its URLs aren't deduped against `web-search` results.

### `start-research` (`src/tools/start-research.ts`)

- `buildStaticScaffolding(goal?)` — ~1100 tokens of fixed guidance. Always emitted. Does not branch on LLM availability.
- `renderResearchBrief()` — called only when a goal is provided and the planner is reachable. When it fails, the footer line `Goal-tailored brief unavailable...` is appended.

## Summary table

| Tool | Output-building files | Output-shaping helpers used | Next Steps footer owner |
|---|---|---|---|
| `start-research` | `src/tools/start-research.ts` | `buildStaticScaffolding`, `renderResearchBrief`, `src/services/llm-processor.ts` | Inline in `start-research.ts` |
| `web-search` | `src/tools/search.ts`, `src/utils/url-aggregator.ts` | `buildClassifiedOutput`, `buildSignalsSection`, `buildSuggestedFollowUpsSection`, `url-aggregator.ts` consensus/rank logic, `src/utils/response.ts` | `buildSuggestedFollowUpsSection` in `search.ts` |
| `search-reddit` | `src/tools/reddit.ts` | Similar classifier path as `web-search`; no `url-aggregator` integration | Inline in `reddit.ts` |
| `scrape-links` | `src/tools/scrape.ts` | `MarkdownCleaner`, `formatBatchHeader` from `response.ts` | Inline in `scrape.ts` |
| `get-reddit-post` | `src/tools/reddit.ts` | `processContentWithLLM` from `llm-processor.ts`, `formatBatchHeader` from `response.ts` | Inline in `reddit.ts` |

## Implications for the output-shaping work-units

- **Output-shaping/01** (strip HTML chrome) → edit `src/tools/scrape.ts` only.
- **Output-shaping/02** (compact per-row metadata) → touches both `src/tools/search.ts` and `src/utils/url-aggregator.ts`.
- **Output-shaping/03** (migrate to `object()` + `structuredContent`) → every tool's handler + `src/utils/response.ts`. This is the biggest refactor because today's callers of `text(markdownBlob)` must be rewritten to `object({...})`.
- **Output-shaping/04** (shrink `start-research` in degraded mode) → edit `buildStaticScaffolding()` in `src/tools/start-research.ts`.
- **Output-shaping/05** (replace cookie-cutter Next Steps) → `search.ts`, `scrape.ts`, `reddit.ts`; consider centralizing the footer builder in `response.ts` as part of the change.
- **Output-shaping/06** (hostname-based `source_type` tagging) → `src/tools/search.ts` + `src/schemas/web-search.ts`.
- **Output-shaping/07** (pretty-print JSON over 20 KB) → wherever the final `text()` call lives in each handler; lowest-layer wrapper is safer.

## The anti-pattern driving all of this

Every tool today ultimately returns `text(markdownBlob)`. mcp-use provides `object({ summary, results, metadata })` which (a) emits `structuredContent` that an LLM client can reason over directly, (b) still renders to markdown for text-only clients, and (c) is smaller on the wire because it elides redundant labelling. See `06-mcp-use-best-practices-primer.md` item 1 and 7.

## Evidence

- GitHub Explore map confirming `buildClassifiedOutput`, `buildSignalsSection`, `buildSuggestedFollowUpsSection` live in `src/tools/search.ts`.
- Probe output showing `CONSENSUS` on every row and `Consistency: n/a` on single-query hits (see `02-current-tool-surface.md`).
- Probe output showing "Next Steps" templates built per-tool with inconsistent wording between `scrape-links` and `get-reddit-post`.
- `src/utils/response.ts` code map showing only four shared helpers (`formatError`, `formatSuccess`, `formatBatchHeader`, `formatDuration`).
