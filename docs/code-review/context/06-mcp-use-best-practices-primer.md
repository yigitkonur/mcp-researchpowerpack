# mcp-use Best Practices Primer

## Purpose

Give the contributor a single list of the 15 mcp-use conventions the server is **not** yet using, each paired with (a) the API or type to reach for, (b) the anti-pattern it replaces in this codebase, and (c) the `build-mcp-use-server` skill reference file to check for deeper guidance. The file ends with the anti-pattern shortlist that the skill flags server-wide.

## The 15 practices

### 1. Response helpers

- **Practice:** Use mcp-use's response helpers instead of hand-building markdown.
- **API:**
  ```ts
  import { text, object, error, mix, markdown, image, audio, binary } from "mcp-use/server"
  ```
- **Anti-pattern replaced:** Every tool currently returns `text(markdownBlob)`. Failures are also wrapped in `text()`, leaking `success: true` on failure bodies.
- **Skill reference:** `build-mcp-use-server` → `response-helpers.md`.

### 2. `.strict()` on Zod schemas

- **Practice:** Chain `.strict()` on every Zod object so hallucinated fields are rejected server-side.
- **API:** `z.object({...}).strict()`.
- **Anti-pattern replaced:** Current schemas in `src/schemas/*.ts` do not call `.strict()`, so unknown keys pass through.
- **Skill reference:** `build-mcp-use-server` → `schemas-zod.md`.

### 3. Capability gating

- **Practice:** Branch on client capabilities before using features like sampling, elicitation, or apps.
- **API:** `ctx.client.can('sampling' | 'elicitation')`, `ctx.client.supportsApps()`.
- **Anti-pattern replaced:** No gating anywhere; the bootstrap gate is the only precondition.
- **Skill reference:** `build-mcp-use-server` → `capabilities.md`.

### 4. `error()` for expected failures, throw for unexpected

- **Practice:** Return `error(msg)` for anticipated failure modes (bad input, unavailable upstream). Throw for truly unexpected problems.
- **API:** `error("message")` from `mcp-use/server`.
- **Anti-pattern replaced:** `get-reddit-post` returns a success body with `Successful: 0` on total failure; see `02-current-tool-surface.md`.
- **Skill reference:** `build-mcp-use-server` → `errors.md`.

### 5. Session stores

- **Practice:** Use the provided session stores rather than hand-rolling.
- **API:** `InMemorySessionStore`, `FileSystemSessionStore`, `RedisSessionStore` from `mcp-use/server`.
- **Anti-pattern replaced:** `InMemoryWorkflowStateStore` with no eviction (`src/services/workflow-state.ts`).
- **Skill reference:** `build-mcp-use-server` → `sessions.md`.

### 6. Capability advertisement via `ctx.log()`

- **Practice:** Emit structured logs so capability-aware clients (Inspector, Claude Code) see degraded-mode events.
- **API:** `await ctx.log(level, message, meta?)` with 8 levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.
- **Anti-pattern replaced:** No logs emitted on any LLM-degraded path; clients must parse body text to notice.
- **Skill reference:** `build-mcp-use-server` → `logging.md`.

### 7. `object()` over `text(JSON.stringify(x))`

- **Practice:** Use `object({...})` so mcp-use emits `structuredContent` plus auto-rendered markdown. Smaller on the wire; an LLM can reason over structure.
- **API:** `object({ summary, results, metadata })` from `mcp-use/server`.
- **Anti-pattern replaced:** Current web-search / scrape-links responses are hand-built markdown blobs. See `05-output-formatting-patterns.md`.
- **Skill reference:** `build-mcp-use-server` → `structured-content.md`.

### 8. Two health checks, not one

- **Practice:** Expose both an HTTP `/health` endpoint (for load balancers) and an MCP `health://status` resource (for clients). The resource body should include dependency availability — not just uptime.
- **API:** Standard HTTP handler + `server.registerResource("health://status", ...)` on mcp-use.
- **Anti-pattern replaced:** `health://status` resource is present but omits `llm_planner_ok`, `llm_extractor_ok`, workflow-store type.
- **Skill reference:** `build-mcp-use-server` → `health-checks.md`.

### 9. Built-in Logger

- **Practice:** Configure mcp-use's root Logger once at startup so server-side logs follow a single format.
- **API:**
  ```ts
  import { Logger } from "mcp-use"
  Logger.configure({ level: "info" })
  ```
- **Anti-pattern replaced:** Ad hoc `console.log` scattered across services.
- **Skill reference:** `build-mcp-use-server` → `logging.md`.

### 10. Zod as a direct dependency

- **Practice:** Zod has been a peer dep since mcp-use v1.21.5. Declare it directly in `package.json`.
- **API:** Add `"zod": "^4.x"` to `dependencies`.
- **Anti-pattern replaced:** Implicit transitive dependency — breakage risk on mcp-use upgrade.
- **Skill reference:** `build-mcp-use-server` → `dependencies.md`.

### 11. Graceful shutdown

- **Practice:** Handle `SIGTERM` / `SIGINT` → `server.close()` → flush Redis / DB connections with a 10s hard-timeout fallback.
- **API:** Node's `process.on("SIGTERM", ...)`, mcp-use's `server.close()`.
- **Anti-pattern replaced:** Process exits abruptly on restart, orphaning in-memory sessions (compounds the `contract-fixes/04` TTL issue).
- **Skill reference:** `build-mcp-use-server` → `lifecycle.md`.

### 12. Tool naming and descriptions

- **Practice:** Action-verb + noun, kebab-case. Descriptions written **for LLMs** (what the tool does, when to call it, what it returns), not for humans reading a README.
- **API:** `description` field on `registerTool()`.
- **Anti-pattern replaced:** Not currently flagged as broken, but `get-reddit-post` vs `scrape-links` naming overlap suggests a review pass is worthwhile.
- **Skill reference:** `build-mcp-use-server` → `tool-design.md`.

### 13. Tool annotations

- **Practice:** Declare `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on every tool. Lets capability-aware clients batch safely.
- **API:** `annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }`.
- **Anti-pattern replaced:** None — server already ships these on all 5 tools.
- **Skill reference:** `build-mcp-use-server` → `annotations.md`.

### 14. Testing via Inspector

- **Practice:** Exercise the server interactively during development.
- **API:** `npx @mcp-use/inspector --url http://localhost:3000/mcp` or `mcp-use dev` (exposes `/inspector`).
- **Anti-pattern replaced:** Current test suite (`tests/http-server.ts`) validates discovery but does not assert tool output bodies.
- **Skill reference:** `build-mcp-use-server` → `testing.md`.

### 15. CORS and DNS rebinding

- **Practice:** Set `allowedOrigins` on the `MCPServer` constructor and make sure `cors.allowHeaders` includes `mcp-session-id` so Streamable HTTP works in browsers.
- **API:** `new MCPServer({ allowedOrigins, cors: { allowHeaders: ["mcp-session-id", ...] } })`.
- **Anti-pattern replaced:** Server is HTTP-only; unconfirmed whether current CORS rules cover `mcp-session-id`. Worth a grep on `index.ts`.
- **Skill reference:** `build-mcp-use-server` → `transport-http.md`.

## Anti-pattern shortlist the skill flags

The `build-mcp-use-server` skill flags these patterns server-wide; each one has at least one instance in `mcp-researchpowerpack-http` today:

- **Raw API passthrough** — dumping 100+ fields from an upstream API into the response.
- **God tools** — one tool with a `mode` param that does CRUD + search.
- **Silent failures** — no `error()` calls; exceptions crash the process.
- **Missing `.describe()` on Zod fields** — callers have to guess intent.
- **`z.any()` / `z.unknown()`** — gives up the schema contract.
- **Unchecked `ctx.elicit()` / `ctx.sample()`** — skipping `ctx.client.can()` before calling.
- **Using raw SDK instead of mcp-use** — not applicable here (server already uses mcp-use) but worth keeping on the list.
- **Missing `.strict()` on schemas** — hallucinated fields sneak through.
- **Unhandled throws** — every handler needs an outer try/catch or `error()` return.
- **No logging strategy** — `ctx.log()` never called.
- **Unbound in-memory caches** — `InMemoryWorkflowStateStore` has no TTL today.
- **Secrets in responses/logs** — audit before merging any structured-content migration.

## Evidence

- mcp-use framework conventions per `build-mcp-use-server` skill reference files.
- Observed server behaviors in `02-current-tool-surface.md` and `03-llm-degradation-paths.md`.
- Tool annotation presence verified via probe (see `01-server-architecture-map.md`).
