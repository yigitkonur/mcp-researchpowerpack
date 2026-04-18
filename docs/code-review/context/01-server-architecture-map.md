# Server Architecture Map

## Purpose

Give a cold contributor a one-page map of the `mcp-researchpowerpack-http` v4.2.4 repository so every work-unit in this plan can refer to a module by path without re-explaining what lives where. The map was confirmed by direct source inspection (GitHub Explore agent), not inferred from tool output.

## Framework and transport

- Framework: **mcp-use** (Nicepkg's MCP framework). Not the raw `@modelcontextprotocol/sdk`.
- Node: `>=20.19`.
- Transport: **HTTP only** (Streamable HTTP). No stdio.
- Bootstrap gate: every tool except `start-research` calls `requireBootstrap()` before handling.
- Prompts: `deep-research`, `reddit-sentiment` (under `src/prompts/`).

## Source tree (abbreviated)

```
src/
├── tools/
│   ├── registry.ts           ← tool-registration list
│   ├── search.ts             ← web-search handler + output builder
│   ├── reddit.ts             ← search-reddit + get-reddit-post handlers
│   ├── scrape.ts             ← scrape-links handler + per-URL formatter
│   └── start-research.ts     ← bootstrap handler
├── schemas/
│   ├── web-search.ts         ← Zod v4
│   ├── reddit.ts
│   └── scrape-links.ts
├── services/
│   ├── llm-processor.ts      ← ~600 LOC central LLM module
│   └── workflow-state.ts     ← WorkflowStateStore (in-mem + Redis)
├── utils/
│   ├── bootstrap-guard.ts    ← requireBootstrap()
│   ├── workflow-key.ts       ← per-client key construction
│   ├── response.ts           ← formatError / formatSuccess / formatBatchHeader / formatDuration
│   └── url-aggregator.ts     ← dedup + CTR-weighted ranking + CONSENSUS flag
├── config/                   ← capability detection, Proxy-lazy env loader
└── prompts/                  ← deep-research, reddit-sentiment
tests/
├── http-server.ts            ← integration, spawns server on :3000
└── *.test.ts                 ← Node native node:test unit tests
index.ts                      ← server bootstrap + health endpoints
```

## Critical files (cross-cut by work-units)

| Path | Role | Referenced by |
|---|---|---|
| `src/tools/registry.ts` | Registration list for all 5 tools. Entry point for adding/removing. | tool-surface/01, 02, 03, 04; contract-fixes/03 |
| `src/tools/search.ts` | `web-search` handler. Uses `buildClassifiedOutput`, `buildSignalsSection`, `buildSuggestedFollowUpsSection`. | tool-surface/02; output-shaping/02, 03, 05, 06, 07; llm-degradation/02 |
| `src/tools/reddit.ts` | Houses both `search-reddit` and `get-reddit-post`. | tool-surface/01, 02, 04; contract-fixes/01 |
| `src/tools/scrape.ts` | `scrape-links` handler. Uses `MarkdownCleaner`. | tool-surface/03; output-shaping/01, 03, 05; llm-degradation/03 |
| `src/tools/start-research.ts` | Bootstrap handler. Calls `buildStaticScaffolding(goal?)` and optionally `renderResearchBrief()`. | output-shaping/04; llm-degradation/01, 02 |
| `src/schemas/web-search.ts` | Zod schema for `web-search`. | tool-surface/02; output-shaping/06 |
| `src/schemas/reddit.ts` | Zod schemas for both Reddit tools. | tool-surface/01, 02, 04 |
| `src/schemas/scrape-links.ts` | Zod schema for `scrape-links`. | tool-surface/03 |
| `src/services/llm-processor.ts` | Lazy-singleton OpenAI SDK client with OpenRouter default base URL. Functions: `createLLMProcessor`, `generateResearchBrief`, `classifySearchResults`, `processContentWithLLM`, `suggestRefineQueriesForRawMode`. Fallback model via `LLM_FALLBACK_MODEL`. Retry-with-backoff + `withStallProtection()` 15s timeout. | llm-degradation/01, 02, 03; output-shaping/04, 06 |
| `src/services/workflow-state.ts` | `WorkflowStateStore` interface. `InMemoryWorkflowStateStore` has **no TTL**. `RedisWorkflowStateStore` uses `EX` with `WORKFLOW_STATE_TTL_SECONDS = 86400` (24h). | contract-fixes/04 |
| `src/utils/bootstrap-guard.ts` | `requireBootstrap()`. Returns mcp-use `error(BOOTSTRAP_MESSAGE)` if not bootstrapped. | contract-fixes/03 |
| `src/utils/workflow-key.ts` | Builds `chatgpt:<subject>:<conversationId>` or `session:<sessionId>` from `ctx.client.user()` + `ctx.session.sessionId`. | contract-fixes/04 |
| `src/utils/response.ts` | Shared `formatError`, `formatSuccess`, `formatBatchHeader`, `formatDuration`. | output-shaping/02, 03, 05 |
| `src/utils/url-aggregator.ts` | URL dedup, CTR-weighted ranking, `isConsensus` flag when URL appears in `>=CONSENSUS_THRESHOLD` queries (threshold appears to be `1` in current deploy — every row gets the label). | output-shaping/02 |
| `src/config/*.ts` | Capability detection, env parsing via Proxy-lazy loader. | contract-fixes/02 |
| `index.ts` | Server bootstrap + health endpoints. | contract-fixes/02, 04 |
| `tests/http-server.ts` | Integration. Spawns server on `:3000`, validates discovery + schema. **No tool-output assertions.** | every mcp-revision |
| `tests/*.test.ts` | Node `node:test` unit. Files: `start-research.test.ts`, `workflow-state.test.ts`, `workflow-key.test.ts`, `llm-processor-fallback.test.ts`, `reddit-keyword-guard.test.ts`, `sanitize.test.ts`, `refine-queries-render.test.ts`, `agent-behavior.ts` (live eval, skipped without `OPENAI_API_KEY`). | every mcp-revision |

## mcp-use conventions the server already follows

- **Tool annotations** on every tool: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (verified during probe).
- **Zod schemas** in `src/schemas/*.ts` imported into the handler, passed into the mcp-use `registerTool({ inputSchema })` API.
- **Capability detection** in `src/config/*.ts` — lazy Proxy loader reads env once and surfaces capability flags.
- **HTTP-only** Streamable HTTP transport — no stdio fallback, which keeps the bootstrap assumptions tight.
- **Bootstrap gate**: `requireBootstrap()` is the single pre-check for tool-body handlers. It uses mcp-use's `error()` helper (not a thrown exception) so clients see an expected failure.
- **MCP prompts** registered alongside tools (`deep-research`, `reddit-sentiment`).

## Conventions the server does *not* yet follow

Full detail lives in `06-mcp-use-best-practices-primer.md`. High-level gaps: hand-built markdown via `text()` instead of `object()` with `structuredContent`; no `.strict()` on Zod schemas; no `ctx.log()` on degraded-mode paths; no `ctx.client.can()` capability gating; in-memory session store with no eviction; `health://status` resource body omits planner/extractor availability.

## Evidence

- GitHub Explore agent output enumerating `src/tools/`, `src/schemas/`, `src/services/`, `src/utils/`, `src/config/`, `src/prompts/`, `tests/`.
- `health://status` probe body (see `04-session-and-workflow-state.md`) confirming `name: mcp-researchpowerpack-http`, `version: 4.2.4`, `transport: http`.
- Tool annotation verification via `mcpc tools-list` during the same session.
