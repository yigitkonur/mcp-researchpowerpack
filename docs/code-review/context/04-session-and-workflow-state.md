# Session and Workflow State

## Purpose

Explain how the bootstrap gate works, where session state lives, how workflow keys are constructed per client, and what the TTL story looks like today. This is the background a contributor needs before touching `contract-fixes/04` (in-memory TTL) or `contract-fixes/03` (precondition annotation).

## Bootstrap gate flow

Every tool except `start-research` runs through `requireBootstrap()` in `src/utils/bootstrap-guard.ts` before any business logic. The gate reads from `WorkflowStateStore` using a key built by `src/utils/workflow-key.ts`.

```
Client call (e.g. web-search)
        │
        ▼
┌─────────────────────────────┐
│ src/utils/bootstrap-guard   │
│ requireBootstrap(ctx)       │
└─────────────────────────────┘
        │
        ├──► buildKey(ctx.client.user(), ctx.session.sessionId)   [workflow-key.ts]
        │
        ▼
┌─────────────────────────────┐
│ WorkflowStateStore.get(key) │   [workflow-state.ts]
└─────────────────────────────┘
        │
  ┌─────┴─────┐
  ▼           ▼
state?    no state
  │           │
  │           ▼
  │    return error(BOOTSTRAP_MESSAGE)   ← mcp-use error() helper
  │
  ▼
continue to tool handler
```

`start-research` itself does not call `requireBootstrap()`; it **writes** the state entry via `WorkflowStateStore.patch()` on first invocation. The `error(BOOTSTRAP_MESSAGE)` path is how the subagent discovered the gate in the derailment run (see `07-derailment-evidence.md`).

## Workflow-key construction

`src/utils/workflow-key.ts` inspects `ctx.client.user()` (identity from MCP client) and `ctx.session.sessionId` and produces one of:

| Client | Key shape |
|---|---|
| Claude.ai / Claude Desktop (has a subject + conversationId) | `chatgpt:<subject>:<conversationId>` |
| ChatGPT (same scheme, reusing the `chatgpt:` prefix) | `chatgpt:<subject>:<conversationId>` |
| Anything else / unknown client | `session:<sessionId>` |

The `chatgpt:` prefix is historical; the scheme is really "subject + conversationId when available, session-id otherwise." This means two different Claude conversations in the same browser won't collide, while two anonymous clients with fresh sessions each get independent state.

## Stores and TTLs

`src/services/workflow-state.ts` defines a `WorkflowStateStore` interface with two concrete implementations.

| Store | TTL | Eviction | When selected |
|---|---|---|---|
| `InMemoryWorkflowStateStore` | **none** | **none — entries live until process restart** | Default when no Redis URL configured |
| `RedisWorkflowStateStore` | `WORKFLOW_STATE_TTL_SECONDS = 60 * 60 * 24 = 86400` (24h) | Native `EX` expiry on `SET` | When Redis URL configured |

The Redis path uses `SET key value EX 86400`. The in-memory path uses a plain `Map.set` and never revisits. `patch()` updates without bumping any timestamp.

## Why 521 active sessions at 31h uptime points to an in-memory leak

Probe of `health://status` captured:

```json
{
  "status": "ok",
  "name": "mcp-researchpowerpack-http",
  "version": "4.2.4",
  "transport": "http",
  "uptime_seconds": 111581,
  "active_sessions": 521,
  "timestamp": "2026-04-18T09:45:59.624Z"
}
```

111581s ≈ 31 hours of uptime. 521 sessions divided by 31h is ~17 new sessions/hour, but `active_sessions` is a **current gauge**, not a rolling counter. For that number to be current, either (a) the server really has 521 concurrent live clients, or (b) sessions are being stored and never evicted.

Given the in-memory store has **no TTL** and `workflow-key.ts` guarantees a new key per anonymous session (via `session:<sessionId>`), the second explanation is by far the most likely. Every `start-research` call from a non-identified client creates an entry the process can never reclaim without a restart. `mcp-revisions/contract-fixes/04` fixes this with an eviction sweep on `patch()`.

## Health resource body (verbatim from probe)

```json
{"status":"ok","name":"mcp-researchpowerpack-http","version":"4.2.4","transport":"http","uptime_seconds":111581,"active_sessions":521,"timestamp":"2026-04-18T09:45:59.624Z"}
```

Notable omissions: no `llm_planner_ok`, no `llm_extractor_ok`, no last-successful-LLM-call timestamp, no indication of which store backs `WorkflowStateStore`. Contract-fixes/02 extends this resource body to include planner/extractor availability so clients can render degraded-mode once instead of per-call.

## Note on `health-resource.ts`

The GitHub Explore pass did not confirm a dedicated `src/services/health-resource.ts` file. The resource registration for `health://status` is either inlined in `index.ts` or lives in a different module name. A contributor working on `contract-fixes/02` should grep for `health://status` or `registerResource(` to locate the exact point of edit before opening a PR.

## Evidence

- `health://status` probe body captured 2026-04-18, reproduced verbatim above.
- `src/services/workflow-state.ts` code map confirming `InMemoryWorkflowStateStore` uses `Map.set` with no TTL hook, while `RedisWorkflowStateStore` uses `EX` with `WORKFLOW_STATE_TTL_SECONDS = 86400`.
- `src/utils/workflow-key.ts` code map confirming the `chatgpt:` / `session:` prefix logic.
- `src/utils/bootstrap-guard.ts` confirming `requireBootstrap()` returns via mcp-use `error()` rather than throwing.
