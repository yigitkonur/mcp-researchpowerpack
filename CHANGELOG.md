# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This server has a hosted deployment at `https://research.yigitkonur.com/mcp`.
You can also install from npm or clone the repo and deploy it to your own
infrastructure.

## [6.0.14] - 2026-04-30

### Removed

- Removed the optional MCP prompts `deep-research` and `reddit-sentiment`.
  The server now exposes the three research tools plus health resources only.

## [6.0.12] - 2026-04-30

### Fixed

- `scrape-links` now mirrors the rendered scrape markdown into
  `structuredContent.content` again. Some MCP bridge clients expose only
  structured tool output to the model; with metadata-only structured output,
  successful scrapes appeared empty except for counts.

## [6.0.10] - 2026-04-23

**Current v6 contract.** The server is now a 3-tool, description-led research
MCP server: `start-research`, `web-search`, and `scrape-links`.

### Changed

- **3-tool surface.** `get-reddit-post` was merged into `scrape-links`.
  Reddit post permalinks (`reddit.com/r/.../comments/...`) are auto-detected
  and routed through the Reddit API for threaded post + comment extraction.
  `search-reddit` remains replaced by `web-search` with
  `scope: "reddit"` or `scope: "both"`.
- **No bootstrap gate.** `start-research` is still strongly recommended and its
  tool description asks agents to call it first, but other tools no longer
  require a prior `start-research` call. The old workflow-state store is gone;
  each tool call is independent.
- **Document routing in `scrape-links`.** PDF / DOCX / PPTX / XLSX URLs route
  through Jina Reader (`r.jina.ai`) before any Scrape.do call. If a normal web
  URL returns a binary document content type through Scrape.do, the handler
  reroutes that URL through Jina instead of returning binary garbage.
- **LLM resilience.** LLM config is `LLM_API_KEY` + `LLM_BASE_URL` +
  `LLM_MODEL`, with optional `LLM_FALLBACK_MODEL`. Requests use low reasoning,
  bounded retries, stall protection, per-request deadlines, and fallback-model
  routing for oversized or context-window failures.
- **Hosted and self-hosted wording.** The public hosted URL is
  `https://research.yigitkonur.com/mcp`; self-hosting remains supported via
  npm/source installs.
- **Run-research install hint.** `start-research` points agents at the current
  skill install command:
  `npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /run-research`.

## [5.0.0] - 2026-04-18

**The major rename + contraction release.** This is one of those rare semver
majors where everything you depend on at the wire level keeps working: the
MCP URL is unchanged, the four surviving tools accept their old inputs, the
old `npx` bin names still resolve. What changed is the **shape of the surface**
— one tool is gone, one tool grew two new parameters, contracts that were
silently wrong are now loud, and the package + GitHub repo got a shorter name.

**Tool count drops from 5 → 4. Token cost per call drops 30–60% on most paths.**
Pair the server with the [`run-research`](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/run-research)
skill for the full agentic playbook.

### Why a major bump

- **Removed a tool.** `search-reddit` is gone. Code that called it by name will
  see `tools/list` return four entries instead of five and the call will fail.
- **Changed an `isError` contract.** `get-reddit-post` and `scrape-links` now
  flip `isError: true` on whole-batch failure where they used to return
  `isError: false` with a sad body. Callers that gated on `isError` to detect
  failure will see the new behavior immediately.
- **Renamed the npm package.** `mcp-researchpowerpack-http` → `mcp-researchpowerpack`.
  Existing installs keep working (the old package is frozen at 4.2.5; bin
  aliases are kept on the new package), but `package.json` references and
  registry URLs change.

If you only consume your existing deployment from an LLM client, you do not
need to do anything except possibly update one tool name in your prompts
(`search-reddit` → `web-search` with `scope: "reddit"`).

### Renamed

- **Package: `mcp-researchpowerpack-http` → `mcp-researchpowerpack`.** The HTTP suffix was redundant — this server has only ever been HTTP. Legacy bin names (`mcp-researchpowerpack-http`, `mcp-research-powerpack-http`) still work, so existing `npx` commands keep functioning. The npm package `mcp-researchpowerpack-http` is frozen at 4.2.5 and superseded by this one.
- **GitHub repo: `mcp-researchpowerpack-http` → `mcp-researchpowerpack`.** GitHub auto-redirects the old URL.
- **Manufact deployment binding** updated to the new repo. Existing deployments keep their URL — no client config update required.

### Removed

- **`search-reddit` tool deleted.** Reddit discovery now flows through `web-search` with `scope: "reddit"`. Drops a tool that leaked subreddit-homepage URLs and unrelated namesake hits (a "Portkey" query was returning Harry Potter results). Server-side filtering means cleaner results without client-side regex juggling.
- **Cookie-cutter `Next Steps:` footers** with literal `[...]` placeholders (e.g. `→ web-search(queries=[...], extract="verify scraped content")`) are gone from `scrape-links` and `get-reddit-post`. They were anti-guidance — agents copy-pasted malformed tool calls from them.

### Added

- **`web-search` `scope` parameter** — `"web"` (default), `"reddit"`, or `"both"`. The reddit scope appends `site:reddit.com` server-side and filters results to `/r/.+/comments/[a-z0-9]+/` permalinks. The both scope runs each query twice and merges. Subreddit homepages and `/rising` / `/new` listings are dropped at the source.
- **`web-search` `verbose` parameter** — opt back into per-row metadata (`Score | Seen in | Best pos | Consistency`), the `CONSENSUS` label, and the trailing Signals block. Default off because these were noise on a typical 3-query call (every row was labeled CONSENSUS, every row showed `Consistency: n/a`, ~1.5KB of zero-signal chrome).
- **`web-search` per-result `source_type`** in `structuredContent.results[]` — hostname/path heuristic into one of `reddit | github | docs | blog | paper | qa | cve | news | video | web`. Always present, even when the LLM classifier is offline. When the classifier is online its tag wins.
- **`start-research` `include_playbook` parameter** — force the full ~1100-token playbook even when the planner is offline. Default `false`, which means the server emits a compact ~280-token stub when the planner can't be reached. Saves ~800 tokens per session-boot in the steady state.
- **`run-research` skill install hint** rendered on every `start-research` call. The MCP server is the toolbelt; the skill is the discipline. Install with: `npx -y skills add -y -g yigitkonur/skills-by-yigitkonur/skills/run-research`.
- **HTML chrome stripping** in `scrape-links` via Mozilla Readability over jsdom. Cookie banners, nav, footer, and related-article lists are dropped before HTML→Markdown conversion. Same pipeline runs whether the LLM extractor is online or not.
- **LLM health on `health://status`** — `llm_planner_ok`, `llm_extractor_ok`, `llm_planner_checked_at`, `llm_extractor_checked_at`, `llm_planner_error`, `llm_extractor_error`, `planner_configured`, `extractor_configured`. Capability-aware clients can read this once at session start instead of parsing per-call footers. Plus `workflow_state_size` for in-memory store visibility.
- **Initialize-time `experimental.research_powerpack` capability** — `planner_available`, `extractor_available`, `planner_model`, `extractor_model`, `requires_bootstrap: ["web-search", "scrape-links", "get-reddit-post"]`. Surfaces via the standard MCP `experimental` escape hatch on every per-session native server.
- **`_meta.requires: ["start-research"]`** on every gated tool's `tools/list` entry. Capability-aware clients can skip pre-bootstrap calls instead of discovering the gate by hitting it.
- **`ctx.log()` warnings** on every LLM-fallback path (`llm_planner_unreachable`, `llm_classifier_unreachable`, `llm_extractor_unreachable`). Clients can render degraded mode once at the first signal.
- **`AGENTS.md`** — process standard for AI agents working on this repo. Pre-push verification chain, post-push live verification with the `test-by-mcpc-cli` skill, acceptance criteria table, don'ts list.
- **`docs/code-review/context/`** — seven grounding documents (architecture map, current tool surface with probe numbers, LLM degradation paths, session/workflow state, output formatting patterns, mcp-use best practices, derailment evidence) committed alongside the implementation.

### Changed

- **`get-reddit-post` returns `isError: true`** when every URL in the batch fails. Previously returned `isError: false` with `Successful: 0` in the body, requiring callers to text-scrape to detect failure. Same fix for `scrape-links`. Partial success still resolves with `isError: false`.
- **`scrape-links` rejects Reddit URLs** with `UNSUPPORTED_URL_TYPE` and points at `get-reddit-post`. Whole-batch rejection rather than partial routing — silent partial routing was the worst of both worlds.
- **`start-research` scaffolding** is honest about LLM availability. When the planner is offline, the loop step that would promise `synthesis`, `gaps`, and `refine_queries` is replaced with a synthesize-from-raw-URLs instruction. Agents no longer waste a turn looking for fields that won't arrive.
- **`scrape-links` batch header** is honest about LLM accounting. Reports `LLM extraction: ok/total succeeded`; when zero URLs extracted but the LLM was attempted, explicitly notes `LLM credit: 0 charged (no extraction produced)`.
- **In-memory workflow store** now enforces a 24h TTL matching the Redis store. Sweep runs at most once per 60s on `patch()`; `get()` also performs a per-entry expiry check. Closes the unbound-cache leak that produced 521 active sessions at 31h uptime.
- **`reddit-keyword-guard`** message updated to point at `web-search` `scope: "reddit"` instead of the deleted `search-reddit`. The guard is bypassed when scope is `reddit` or `both` (intentional Reddit context, not a tool-choice mistake).

### Fixed

- **MCP-spec contract violation** — `isError` on zero-success batches.
- **`InMemoryWorkflowStateStore` leak** — see "Changed" above.

### Migration notes

- **Your deployment URL is unchanged.** If you self-host, the rename does not move your endpoint. Most users need no action.
- **If you were calling `search-reddit`**, switch to `web-search` with `scope: "reddit"`. Same result quality, no subreddit-homepage noise.
- **If you were checking `Successful: 0` text from `get-reddit-post`** to detect failure, switch to checking `response.isError` — it now flips correctly.
- **If you were passing Reddit URLs to `scrape-links`**, you'll now get an `UNSUPPORTED_URL_TYPE` error. Switch those calls to `get-reddit-post`.
- **If you embed the package**, re-install with `npm i mcp-researchpowerpack`. The CLI bin names (`mcp-researchpowerpack-http`, `mcp-research-powerpack-http`) are kept as back-compat aliases.

## [4.3.0] - 2026-04-18

Transitional release that landed the rename only — `mcp-researchpowerpack-http`
→ `mcp-researchpowerpack`. Functionally identical to 5.0.0 above; published
to npm and immediately superseded by 5.0.0 to mark the breaking nature of
the underlying changes (search-reddit removed, isError contract flipped).
Use 5.0.0.

## [4.2.1] – [4.2.5] - 2026-04-15 to 2026-04-17

CI auto-bumped releases under the old `mcp-researchpowerpack-http` npm name.
Final tag of that package — frozen at 4.2.5, no further updates. Switch to
`mcp-researchpowerpack` 5.0.0+.

## [4.2.0] - 2026-04-15

### Added
- `start-research`, a mandatory orientation tool that bootstraps the research workflow per conversation/session.
- Conversation-aware workflow state with safe `ctx.client.user()` / `ctx.session.sessionId` keying.
- `deep-research` and `reddit-sentiment` MCP prompts.
- `pnpm test:unit` and `pnpm test:evals`, plus an eval artifact writer at `test-results/eval-runs/<timestamp>.json`.
- A one-shot `web-search` Reddit misuse guard that redirects agents to `search-reddit`.

### Changed
- Research tools now enforce the `start-research` bootstrap gate before execution.
- Tool responses now always include structured MCP output alongside markdown content.
- `web-search` now appends `Signals` plus `Suggested follow-up searches` generated from the classifier output, including raw mode when an LLM is available for refine generation.
- README and `.env.example` now match the current v4.x workflow and configuration model.

## [3.11.0] - 2026-04-09

### Changed (BREAKING)
- `structuredContent` on every tool response no longer mirrors the rendered markdown. Clients that read `result.structuredContent.content` must switch to `result.content[0].text`. The top-level `content` block is unchanged.
- Output schemas (`webSearchOutputSchema`, `scrapeLinksOutputSchema`, `searchRedditOutputSchema`, `getRedditPostOutputSchema`) now expose only `metadata` at the top level.

### Added
- Production fail-fast guard: server exits with code 1 if `NODE_ENV=production` and neither `ALLOWED_ORIGINS` nor `MCP_URL` is set (DNS rebinding protection).
- Integration test coverage for schema-rejection on every tool (empty/too-few inputs, invalid URL schemes).
- Integration test coverage for tool annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`) and `inputSchema` declaration.

### Removed
- STDIO-era dead code in `src/tools/utils.ts` (`ToolLogger` type, `safeLog`, `formatRetryHint`, `formatToolError`, `validateNonEmptyArray`, `validateArrayBounds`, `buildBatchHeader`, `buildStatusLine`).
- Unused `safeLog`, `createToolLogger`, and `ToolLogger` type from `src/utils/logger.ts`.
- Unused `formatList`, `truncateText`, and `ListItem` type from `src/utils/response.ts`.
- Unused `SCRAPER` config constants (`MIN_URLS`, `MAX_URLS`, `MAX_TOKENS_BUDGET`, `RETRY_COUNT`, `RETRY_DELAYS`). `SCRAPER.MIN_URLS: 3` had been contradicting the real schema minimum of `1`.

### Refactored
- Reddit schemas moved from inline in `src/tools/reddit.ts` to `src/schemas/reddit.ts`, matching `web-search.ts` and `scrape-links.ts` and the `CLAUDE.md` convention.
- `src/services/markdown-cleaner.ts` and `src/clients/reddit.ts` now log through the mcp-use `Logger` instead of raw `console.error`.

### Fixed
- `tests/http-server.ts` no longer passes its `web-search` validation assertion by accident. The old `.includes('3')` check matched any digit in unrelated error text; it's replaced with deterministic empty-keywords rejection.

## [3.6.2] - 2026-02-01

### Added

- **Next Steps in Search Results** - Both `search_reddit` and `web_search` now include actionable Next Steps
  - `search_reddit`: Includes ready-to-copy `get_reddit_post` commands with actual URLs from results
  - `web_search`: Includes ready-to-copy `scrape_links` commands with top consensus URLs
  - Both include `deep_research` follow-up suggestions
  - Code block formatting for easy copy-paste

### Changed

- **No Truncation Policy** - Response formatters preserve all content
  - Only header previews use truncation (for display purposes)
  - Full question text, snippets, and URLs are always preserved
  - High-density comprehensive output maintained

## [3.6.0] - 2026-02-01

### Added - Agent-Optimized Response Formatting (70/20/10 Pattern)

- **Standardized Response Format** - All tools now use the 70/20/10 pattern
  - 70% Summary: Key insights, status indicators, metrics
  - 20% Data: Structured results with clear formatting
  - 10% Next Steps: Actionable follow-up commands ready to copy
  - Consistent markdown output across all 5 tools

- **Centralized Utilities**
  - `src/utils/logger.ts` - MCP-compatible logging (uses stderr, never crashes)
    - `mcpLog(level, message, tool)` - Structured logging with emoji prefixes
    - `safeLog()` - Error-swallowing wrapper
    - `createToolLogger()` - Bound logger factory
  - `src/utils/response.ts` - 70/20/10 response formatters
    - `formatSuccess({title, summary, data?, nextSteps?, metadata?})` - Main success response
    - `formatError({code, message, retryable?, howToFix?, alternatives?, toolName?})` - Error with recovery guidance
    - `formatBatchHeader({title, totalItems, successful, failed, ...})` - Batch operation status
    - `formatList()`, `formatDuration()`, `truncateText()` helpers
  - `TOKEN_BUDGETS` constant in `src/tools/utils.ts` for consistent token allocation

- **Improved Error Responses**
  - Structured error format with `code`, `message`, `howToFix`, `alternatives`
  - Retryable errors clearly marked with hints
  - Tool-specific recovery suggestions
  - Alternative tool recommendations on failure

### Changed

- **Response Format** - All tools now return agent-optimized markdown instead of raw JSON
  - `scrape_links` - Added execution time, credits used, next steps with actionable commands
  - `deep_research` - Added question previews, token usage, follow-up suggestions
  - `get_reddit_post` - Standardized batch header, LLM status tracking, recovery hints
  - `search_reddit` - Consistent error formatting with alternatives
  - `web_search` - Added consensus URL counts, next step commands with example URLs

- **Removed Legacy Patterns**
  - Removed per-tool `safeLog()` duplicates (now centralized)
  - Removed per-tool `calculateTokenAllocation()` duplicates (now in utils.ts)
  - Removed `ToolOptions` type with logger/sessionId (simplified signatures)

### Migration Notes

- Tool handlers no longer accept `options` parameter with `logger`/`sessionId`
- All logging now uses `mcpLog()` from `src/utils/logger.ts`
- Response format changed from mixed to standardized markdown
- Old imports still work via re-exports in `src/tools/utils.ts`

## [3.5.1] - 2026-01-31

### Performance

- **Bounded Concurrency** - All parallel operations now use a worker-pool pattern (`pMap`/`pMapSettled`) instead of unbounded `Promise.all`
  - Reddit search: 50 concurrent API calls → 8
  - Web scraping batches: 30 concurrent → 10
  - Deep research questions: unbounded → 3
  - Reddit post fetching: 10 concurrent → 5
  - File attachments: unbounded → 5

- **YAML Config Caching** - `loadYamlConfig()` now caches the parsed YAML in memory instead of reading from disk on every call via `readFileSync`. This eliminates redundant I/O for `getToolConfig()`, `getExtractionSuffix()`, and all config lookups.

- **Async File I/O** - Replaced blocking `existsSync()` in `FileAttachmentService` with async `access()` from `fs/promises` to avoid blocking the event loop.

- **String Concatenation** - Replaced `output +=` loops in `formatCodeBlock()` and `formatAttachments()` with `Array.push()` + `join('')` pattern, eliminating O(n^2) allocations for large files (600+ lines).

- **Module-Level Singletons** - Hoisted `MarkdownCleaner` instance in `scrape.ts` to module level (stateless, reused across requests).

- **Pre-compiled Regex** - Moved Reddit search regex patterns (`/site:\s*reddit\.com/i`, title cleanup regexes) to module-level constants in `search.ts`.

- **Environment Caching** - `parseEnv()` results cached in memory (single read at startup).

### Fixed

- **URL Aggregator Position Logic** - Fixed title/snippet selection in both `aggregateResults()` and `aggregateRedditResults()`. Previously compared against `positions[0]` (first position recorded) instead of the previous best position, which could keep stale metadata when a better-ranked result appeared later.

- **Non-null Assertion Safety** - Replaced `env.SEARCH_API_KEY!`, `env.REDDIT_CLIENT_ID!`, `env.REDDIT_CLIENT_SECRET!` non-null assertions in `registry.ts` with safe `|| ''` fallbacks to prevent runtime crashes if env vars are missing.

- **Reddit Auth Race Condition** - Added promise deduplication (`pendingAuthPromise`) to prevent multiple concurrent `auth()` calls from firing redundant token requests.

### Added

- **`src/utils/concurrency.ts`** - New utility module with `pMap()` (ordered results) and `pMapSettled()` (per-item error isolation) for bounded concurrent execution across the codebase.

## [3.5.0] - 2026-01-04

### Added - LLM Optimization & Aggressive Guidance

- **Aggressive Tool Descriptions** - Transformed all tool descriptions from passive to directive
  - `search_reddit`: Minimum 10 queries enforced (was 3), added 10-category query formula
  - `get_reddit_post`: Stress on using 10-20+ posts for consensus (was 2+)
  - `deep_research`: Enhanced template with numbered sections, file attachment requirements
  - `scrape_links`: Aggressive push for `use_llm=true`, extraction template with OR statements
  - `web_search`: Minimum 3 keywords enforced, search operator examples

- **BAD vs GOOD Examples** - Every tool now shows anti-patterns and perfect examples
  - Visual comparison with ❌ BAD and ✅ GOOD sections
  - Explains WHY each example is bad/good
  - Provides actionable fixes for common mistakes

- **Configurable Limits in YAML** - All limits moved to YAML configuration
  - `limits` section in each tool definition
  - `min_queries`, `max_queries`, `recommended_queries` for search_reddit
  - `min_urls`, `max_urls`, `recommended_urls` for scrape_links and get_reddit_post
  - `min_keywords`, `max_keywords`, `recommended_keywords` for web_search
  - `min_questions`, `max_questions`, `recommended_questions` for deep_research

- **File Attachment Template** - Numbered 5-section format for file descriptions
  - [1] What this file is
  - [2] Why it's relevant
  - [3] What to focus on
  - [4] Known issues/context
  - [5] Related files
  - Includes examples for bugs, performance, refactoring, architecture scenarios

- **Extraction Prompt Templates** - Comprehensive guidance for scrape_links
  - OR-statement formula: "Extract [target1] | [target2] | [target3]"
  - Examples by use case (product research, technical docs, competitive analysis)
  - Minimum 3 extraction targets recommended

- **Query Crafting Strategies** - Detailed examples for search_reddit and web_search
  - Technology research examples
  - Problem-solving examples
  - Comparison research examples
  - Search operator usage (site:, "exact", -exclude, filetype:, OR)

### Changed

- **Tool Descriptions** - Increased verbosity and directiveness
  - Added 🔥 emoji headers for critical requirements
  - Added ━━━ section dividers for readability
  - Added emoji icons (📊, 🎯, ❌, ✅, 💡, 🚀) for visual scanning
  - Changed from "you can" to "you MUST" phrasing
  - Increased emphasis on parallel processing benefits

- **Validation Requirements** - Stricter minimum requirements
  - `search_reddit`: 3 → 10 minimum queries
  - `web_search`: 1 → 3 minimum keywords
  - All tools: Added recommended ranges

- **Sequential Thinking Workflows** - Iterative refinement patterns for all research tools
  - Think → Search → Think → Refine → Search Again pattern
  - Mandatory thinking steps between tool calls
  - Scope expansion based on results
  - Examples of iterative flows for each tool
  - Feedback loop guidance (results inform next search)

### Documentation

- Added `docs/refactoring/06-validation-system-design.md` - Validation architecture
- Added `docs/refactoring/07-llm-optimization-summary.md` - Quick reference guide

## [3.4.0] - 2026-01-04

### Added

- **YAML Configuration System** - All tool metadata now lives in a single `tools.yaml` file
  - Tool descriptions, parameter schemas, and validation rules centralized
  - Easy to update without touching TypeScript code
  - Single source of truth for all tool definitions

- **Handler Registry Pattern** - New `src/tools/registry.ts` with `executeTool` wrapper
  - Declarative tool registration with capability checks
  - Automatic Zod validation for all tools
  - Consistent error handling across all tools
  - Reduced routing code from 80+ lines to single function call

- **Shared Utility Functions** - New `src/tools/utils.ts`
  - `safeLog()` - Logger wrapper that never throws
  - `calculateTokenAllocation()` - Batch token distribution
  - `formatRetryHint()` - Error message formatting
  - `formatToolError()` - Standard error response builder
  - Validation helpers for arrays and bounds

- **YAML Loader Infrastructure** - New `src/config/loader.ts` and `src/config/types.ts`
  - Parses `tools.yaml` at startup
  - Generates MCP-compatible tool definitions
  - Supports both inline parameters and existing Zod schemas
  - Type-safe TypeScript interfaces for YAML config

- **Comprehensive Refactoring Documentation** - 5 design docs in `docs/refactoring/`
  - Architecture overview
  - YAML schema design specification
  - Handler registry design
  - Migration guide for adding new tools
  - Final summary with metrics

### Changed

- **`src/tools/definitions.ts`** - Reduced from 167 lines to 19 lines (-88%)
  - Now imports from YAML loader instead of hardcoded definitions

- **`src/index.ts`** - Reduced from 263 lines to 143 lines (-46%)
  - Uses `executeTool` from registry instead of if/else blocks
  - Uses `getToolCapabilities()` for startup logging

- **Build Process** - Updated to copy YAML files to dist
  - `pnpm build` now includes `cp -r src/config/yaml dist/config/`

### Dependencies

- Added `yaml` package (^2.7.0) for YAML parsing

### Technical Details

- Exported `Capabilities` interface from `src/config/index.ts`
- Added index signature to `CallToolResult` for MCP SDK compatibility
- Handler wrappers accept `unknown` params with internal type casting

## [3.3.2] - Previous Release

See git history for earlier changes.
