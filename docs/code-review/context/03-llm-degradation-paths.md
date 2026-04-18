# LLM Degradation Paths

## Purpose

Walk through `src/services/llm-processor.ts` (~600 LOC) and show, for every exported function, what happens on the success path, on the `LLM_FALLBACK_MODEL` path, and on total failure. Then map each of those failure modes to the tool-level output the agent sees. The goal is to give the contributor a single place to reason about degraded modes before editing any tool.

## Shape of `llm-processor.ts`

- Lazy-singleton OpenAI SDK client. Default base URL: OpenRouter.
- Env keys consulted: `LLM_API_KEY` (planner/classifier) and `LLM_EXTRACTION_API_KEY` (scrape/Reddit extraction).
- Fallback chain: primary model → `LLM_FALLBACK_MODEL` → surface error.
- Every call wrapped in:
  - `withStallProtection()` — 15s timeout.
  - Retry-with-backoff for transient OpenAI errors.
- Five exported functions drive the rest of the server.

## Function-by-function degradation

### `createLLMProcessor()`

| Path | Behavior |
|---|---|
| Success | Returns a singleton processor holding an OpenAI SDK client. Consumed by every other function. |
| Fallback | N/A — construction is env-read only. If `LLM_API_KEY` is missing, returns a processor whose methods will all short-circuit. |
| Total failure | If SDK constructor throws (e.g. bad base URL), subsequent `generate*` / `classify*` calls throw; callers in tool handlers catch and fall back to raw output paths. |

### `generateResearchBrief()`

Used by `start-research` when a `goal` is provided.

| Path | Behavior |
|---|---|
| Success | Returns a Markdown brief tailored to the goal; `start-research` inlines it ahead of the static playbook. |
| Fallback | Retry against `LLM_FALLBACK_MODEL`. Same output contract. |
| Total failure | `start-research` catches, omits the brief, appends the footer `Goal-tailored brief unavailable: LLM planner is not configured or failed this call.` The agent still receives the ~1106-token static playbook. |

### `classifySearchResults()`

Used by `web-search` to tier results by relevance and emit `synthesis` / `gaps` / `refine_queries`.

| Path | Behavior |
|---|---|
| Success | Per-URL `source_type`, consensus reasoning, synthesis block, gap list with IDs, refine-query suggestions tied to gap IDs. |
| Fallback | Same contract on `LLM_FALLBACK_MODEL`. |
| Total failure | Metadata footer appends `"llm_classified":false,"llm_error":"Connection error."`; the main output keeps only CTR-ranked URL list. Every row gets `CONSENSUS` (see `05-output-formatting-patterns.md`) and a `Consistency: n/a` header, because the classifier never ran. |

### `processContentWithLLM()`

Used by `scrape-links` and `get-reddit-post` to clean raw HTML / thread content into focused Markdown.

| Path | Behavior |
|---|---|
| Success | Noise-free Markdown extraction targeted at the caller's `extract` parameter. |
| Fallback | Retry against `LLM_FALLBACK_MODEL`. |
| Total failure | `scrape-links` emits raw HTML-to-Markdown via `MarkdownCleaner` only — cookie banners, nav chrome, repeated hero blocks leak through. `get-reddit-post` prefixes the body with `⚠️ LLM unavailable (LLM_EXTRACTION_API_KEY not set) — raw content returned`. Credits are still charged (see `mcp-revisions/llm-degradation/03`). |

### `suggestRefineQueriesForRawMode()`

Used by `web-search` when the caller passed `raw: true` and LLM is available to still produce follow-up queries.

| Path | Behavior |
|---|---|
| Success | Tacks on a "Suggested follow-ups" block to `raw` output without the full classification pass. |
| Fallback | Same via `LLM_FALLBACK_MODEL`. |
| Total failure | Block omitted silently. `raw:true` and default mode become visually indistinguishable when LLM is off — the probe captured this (default 3-query call and `raw:true` 1-query call had near-identical density, see `02-current-tool-surface.md`). |

## Tool ↔ LLM dependency map

| Tool | LLM input (env key) | What disappears when LLM fails |
|---|---|---|
| `start-research` | `LLM_API_KEY` (`generateResearchBrief`) | Goal-tailored brief. Static playbook remains. Footer line emitted. |
| `web-search` | `LLM_API_KEY` (`classifySearchResults`, `suggestRefineQueriesForRawMode`) | Synthesis block, gap list, refine queries, per-URL `source_type`, meaningful consensus labels. Metadata: `"llm_classified":false,"llm_error":"Connection error."` |
| `search-reddit` | `LLM_API_KEY` (same classifier as `web-search`) | Tiering, relevance filtering, namesake-hit detection. Subreddit homepages leak through. |
| `scrape-links` | `LLM_EXTRACTION_API_KEY` (`processContentWithLLM`) | Clean Markdown extraction. Cookie banners, nav chrome, repeated hero blocks leak through. |
| `get-reddit-post` | `LLM_EXTRACTION_API_KEY` (`processContentWithLLM`) | Structured post + top-comments Markdown. Raw thread content returned with warning banner. |

## How the agent finds out

Today, the only signals a client sees when the LLM is offline are:

- `web-search` metadata footer: `"llm_classified":false,"llm_error":"Connection error."`
- `get-reddit-post` body banner: `⚠️ LLM unavailable (LLM_EXTRACTION_API_KEY not set) — raw content returned`
- `scrape-links` header line: `LLM extraction failures: N` (where N may equal total URLs).
- `start-research` footer: `Goal-tailored brief unavailable: LLM planner is not configured or failed this call.`

None of these are surfaced via `ctx.log()` or the MCP `initialize` capability block. A capability-aware client would have to call a tool, parse body text, and infer state — which is why `mcp-revisions/contract-fixes/02` and `mcp-revisions/llm-degradation/01` exist.

## Evidence

- Probe footer text captured verbatim: `"llm_classified":false,"llm_error":"Connection error."` (web-search 3-query default).
- Probe banner: `⚠️ LLM unavailable (LLM_EXTRACTION_API_KEY not set) — raw content returned` (`get-reddit-post`).
- Probe footer: `Goal-tailored brief unavailable: LLM planner is not configured or failed this call. The static playbook above still applies; you can proceed with it, or retry start-research after verifying LLM_API_KEY.` (`start-research`).
- `scrape-links` header `LLM extraction failures: 1` on a 1-URL call confirms per-URL LLM attempt + fallback accounting.
