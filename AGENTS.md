# AGENTS.md

Operating standard and architecture reference for AI agents working on this repository. `CLAUDE.md` is a symlink to this file — every folder resolves to the same content.

---

## 1. What this repo is

`mcp-researchpowerpack` (v6+) — an HTTP-first MCP server built on [`mcp-use`](https://github.com/nicepkg/mcp-use) exposing **three research tools**: `start-research`, `web-search`, `scrape-links`. ES-module TypeScript, published to npm and deployed via Manufact Cloud (`mcp-use deploy`).

Key design contracts (v6):

- `scrape-links` auto-detects `reddit.com/r/.../comments/` permalinks and routes them through the Reddit API (threaded post + top comments). The previous `get-reddit-post` tool was merged into `scrape-links` in v6 — do not re-add it.
- `web-search` accepts `scope: "web" | "reddit" | "both"`. The previous `search-reddit` tool was replaced by `scope: "reddit"` — do not re-add it.
- Tool discovery is description-led. There is no bootstrap gate — `start-research` is a strong recommendation via tool description, not a runtime precondition.

**Live deployment:** `https://research.yigitkonur.com/mcp` (Manufact Cloud, `deploymentId: 575bc2f7-70c8-45f6-ba13-fa3c5104558a`, org `primary-2e5b3ad6`; tracked in `.mcp-use/project.json`).

---

## 2. Commands

```bash
pnpm install              # install dependencies
pnpm dev                  # local dev with watch (mcp-use dev, serves :3000/mcp)
pnpm build                # compile TypeScript → dist/ (mcp-use build)
pnpm start                # run compiled server
pnpm typecheck            # tsc --noEmit (strict mode)
pnpm test                 # unit tests + HTTP integration test
pnpm test:unit            # tsx --test tests/**/*.test.ts
pnpm test:http            # tsx tests/http-server.ts (spawns server, probes HTTP)
pnpm test:evals           # tsx tests/agent-behavior.ts (eval harness)
pnpm inspect              # @mcp-use/inspector against http://localhost:3000/mcp
pnpm deploy               # deploy to Manufact Cloud (mcp-use deploy)
```

All builds run on the Mac mini. Never build locally. `Makefile` is a symlink to `~/dev/fntalk/scripts/universal-remote-make.mk`, which auto-detects pnpm + TypeScript and proxies every command over SSH.

```bash
make up        # sync + build on mini (~7s incremental)
make test      # run tests on mini
make dev       # start MCP dev server on mini
make deploy    # deploy from mini
make info      # show detected config
```

---

## 3. mcp-use CLI reference

```
npx mcp-use [options] [command]

Commands:
  build           Build TypeScript and MCP UI widgets
  dev             Run development server with auto-reload and inspector
  start           Start production server
  login           Login to mcp-use cloud
  logout          Logout from Manufact cloud
  whoami          Show current user information
  org             Manage organizations
  deploy          Deploy MCP server from GitHub to Manufact cloud
  client          Interactive MCP client for terminal usage
  deployments     Manage cloud deployments
  servers         Manage cloud servers (Git-backed deploy targets)
  skills          Manage mcp-use AI agent skills
  generate-types  Generate TypeScript type definitions (.mcp-use/tool-registry.d.ts)
```

Deploy path: GitHub → Manufact Cloud. No Railway. `.mcp-use/project.json` is tracked in git (via `!.mcp-use/project.json` in `.gitignore`) and is rewritten by every `mcp-use deploy`. If a deploy fails because of that dirty file, commit it or run `git update-index --skip-worktree .mcp-use/project.json` once and retry.

Env var management (Manufact Cloud rejects `env update`; use rm + add):

```bash
npx mcp-use servers env list --server <server-id>
npx mcp-use servers env rm --server <server-id> --key LLM_MODEL
npx mcp-use servers env add --server <server-id> --key LLM_MODEL --value gpt-5.4-mini
```

Container must be redeployed for env var changes to take effect.

---

## 4. Architecture

```
index.ts                     Entry point: server startup, CORS, health endpoints,
                             experimental capability registration, graceful shutdown
src/
  version.ts                 Reads version/name/description from package.json at runtime
  config/index.ts            Central config: env parsing, capability detection,
                             concurrency limits, CTR weights, LLM proxy config
  clients/
    search.ts                Serper client
    reddit.ts                Reddit API client (OAuth + threaded fetch)
    scraper.ts               Scrape.do HTTP scraper client (rejects binary bodies
                             via content-type sniff so the handler can reroute)
    jina.ts                  Jina Reader client (r.jina.ai) — turns PDF / DOCX /
                             PPTX / XLSX URLs into clean markdown
  tools/
    registry.ts              registerAllTools() — wires 3 tools + 2 prompts + resources
    start-research.ts        goal-tailored brief + static playbook + planner circuit-breaker
    search.ts                web-search handler (scope=web|reddit|both, CTR ranking, LLM tiering)
    scrape.ts                scrape-links handler (reddit + web + document branches in
                             parallel; web-branch binary responses reroute to Jina)
    mcp-helpers.ts           MCP response builders: markdown(), error(), toolFailure()
    utils.ts                 Shared formatters
  services/
    llm-processor.ts         LLM extraction, classification, brief generation —
                             primary + fallback model, always low reasoning
    markdown-cleaner.ts      HTML/markdown cleanup (MarkdownCleaner, turndown, readability)
  schemas/                   Zod v4 input validation schemas (one per tool)
    start-research.ts
    web-search.ts
    scrape-links.ts
  prompts/
    deep-research.ts         Optional MCP prompt: deep-research
    reddit-sentiment.ts      Optional MCP prompt: reddit-sentiment
  utils/
    errors.ts                StructuredError with code/retryable/statusCode,
                             classifyError pipeline, withStallProtection
    concurrency.ts           pMap/pMapSettled — thin wrappers over p-map@7
    retry.ts                 Exponential backoff with jitter
    url-aggregator.ts        CTR-weighted URL ranking for web-search consensus
    response.ts              formatSuccess/formatError/formatBatchHeader
    logger.ts                mcpLog() — stderr-only logging (MCP-safe)
    content-extractor.ts     Readability-style extraction helpers
    markdown-formatter.ts    Output formatting primitives
    sanitize.ts              Input sanitization helpers
    source-type.ts           URL/source type classification
```

### Key patterns

- **Capability detection**: `getCapabilities()` in `src/config/index.ts` evaluates which API keys are present at startup. Missing keys disable the affected tool gracefully via `getMissingEnvMessage()`; they never crash the server.
- **Lazy LLM config via `Proxy`**: `LLM_EXTRACTION` throws at first property access if `LLM_BASE_URL` or `LLM_MODEL` are missing while `LLM_API_KEY` is set. Clean startup when LLM is unconfigured.
- **Bounded concurrency**: Every parallel fan-out uses `pMap`/`pMapSettled` with explicit limits (defaults: search 50, scraper 50, reddit 50, LLM 50; override via env, clamped 1–200).
- **Reddit + web + document parallelism in `scrape-links`**: Three branches run concurrently via `Promise.all` and results merge in original input order. The document branch uses `JinaClient` (Jina Reader) to convert PDF / DOCX / PPTX / XLSX URLs to markdown; it receives URLs via both a pre-fetch extension gate (`isDocumentUrl`) and a post-fetch fallback path (Scrape.do returns `UNSUPPORTED_BINARY_CONTENT` when `content-type` is binary, triggering a Jina retry for that URL only).
- **CTR-based URL ranking**: `web-search` scores URLs by CTR position weights (rank 1 → 100, rank 10 → 12.56) and surfaces a static descending weight (`w=N`) to the LLM classifier.
- **Tools never throw**: Every tool handler wraps in try/catch, returning `toolFailure(errorMessage)` so MCP `isError` flips correctly.
- **Structured errors**: `StructuredError` with `code`, `retryable`, `statusCode`, `cause`. See §7 for codes.
- **Stderr-only logging**: `mcpLog()` writes to stderr to avoid polluting the MCP stdout protocol channel.
- **Experimental MCP capability**: `initialize` advertises `experimental.research_powerpack.{planner_available, extractor_available, planner_model, extractor_model}` so capability-aware clients can branch at session start instead of parsing per-call footers. Registered per session in `index.ts` by patching `getServerForSession`.
- **Planner circuit-breaker**: `start-research` short-circuits the LLM brief when the planner has failed ≥2 times within 60s (see §6).
- **Stateless**: There is no workflow-state store in v6. Every tool call is independent. Session IDs are managed entirely by `mcp-use`'s `InMemorySessionStore` for MCP transport, not for business state.

---

## 5. Environment variables

Copy `.env.example`, set only what you need.

### Server

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | bind address; cloud runtimes set `PORT` which auto-switches to `0.0.0.0` |
| `ALLOWED_ORIGINS` | unset | comma-separated origins for host validation / CORS |
| `MCP_URL` | unset | public MCP URL fallback for production origin protection |
| `NODE_ENV` | unset | `production` enforces `ALLOWED_ORIGINS` or `MCP_URL` (exits otherwise) |
| `DEBUG` | unset | `1` or `2` to bump mcp-use debug verbosity |
| `UV_THREADPOOL_SIZE` | `8` (set at boot) | raised from Node's default 4 for parallel DNS |

### Provider keys (each enables its tool)

| Var | Tool |
|---|---|
| `SERPER_API_KEY` | `web-search` (all scopes) |
| `SCRAPEDO_API_KEY` | `scrape-links` (non-reddit, non-document URLs) |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `scrape-links` (reddit.com permalinks — threaded post + comments) |
| `JINA_API_KEY` *(optional)* | `scrape-links` (PDF / DOCX / PPTX / XLSX → markdown via `r.jina.ai`). Works unauthenticated at 20 RPM; key raises the limit to 200+ RPM. |

### LLM (required together when LLM is enabled)

| Var | Required | Notes |
|---|---|---|
| `LLM_API_KEY` | yes | API key for the OpenAI-compatible endpoint |
| `LLM_BASE_URL` | yes with `LLM_API_KEY` | e.g. `https://server.up.railway.app/v1`, `https://api.openai.com/v1` |
| `LLM_MODEL` | yes with `LLM_API_KEY` | primary model, e.g. `gpt-5.4-mini` |
| `LLM_FALLBACK_MODEL` | no | used after primary exhausts retries; gets `FALLBACK_RETRY_COUNT` (currently 3) attempts, e.g. `gpt-5.4` |

`reasoning_effort` is hardcoded to `'low'` on every LLM call — not configurable. No legacy env-var aliases (e.g. `LLM_EXTRACTION_*`, `LLM_REASONING`) — these were removed in v6.

### Concurrency overrides (all optional, all clamped 1–200)

| Var | Default |
|---|---|
| `CONCURRENCY_SEARCH` | 50 |
| `CONCURRENCY_SCRAPER` | 50 |
| `CONCURRENCY_REDDIT` | 50 |
| `LLM_CONCURRENCY` | 50 |

### Eval harness

| Var | Default | Notes |
|---|---|---|
| `EVAL_MCP_URL` | `http://localhost:3000/mcp` | target URL for `pnpm test:evals` |
| `EVAL_MODEL` | `gpt-5.4-mini` | driver model |
| `EVAL_API_KEY` | unset | driver API key |

---

## 6. LLM resilience numbers

All live in `src/services/llm-processor.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `MAX_LLM_INPUT_CHARS` | 500 000 | Hard cap on chars sent to LLM; larger inputs are truncated |
| `MAX_PRIMARY_MODEL_INPUT_CHARS` | 100 000 | Above this, skip the primary model and go straight to fallback (primary has a smaller context window) |
| `LLM_CLIENT_TIMEOUT_MS` | 600 000 | OpenAI SDK client-level timeout (10 min) |
| `LLM_STALL_TIMEOUT_MS` | 75 000 | Per-call stall detection (no data flowing) before abort-and-retry |
| `LLM_REQUEST_DEADLINE_MS` | 150 000 | Per-request hard deadline (2.5 min) |
| `LLM_RETRY_CONFIG.maxRetries` | 2 | Primary model: 1 initial + 2 retries = 3 attempts |
| `FALLBACK_RETRY_COUNT` | 3 | Fallback model: 3 attempts after primary exhausts |

### Retry flow (per-call)

1. If input size > `MAX_PRIMARY_MODEL_INPUT_CHARS`, skip primary — go straight to fallback.
2. Otherwise try primary with `LLM_RETRY_CONFIG.maxRetries` retries and exponential backoff + jitter.
3. If primary errors with a context-window error on any attempt, stop retrying primary and switch to fallback.
4. If primary exhausts retries and `LLM_FALLBACK_MODEL` is set, try fallback up to `FALLBACK_RETRY_COUNT` attempts.
5. Every attempt wrapped in `withStallProtection` (stall timeout) and respects `LLM_REQUEST_DEADLINE_MS`.
6. If all phases fail, surface the error to the caller — tool handlers catch and degrade gracefully (raw output, skipped classification, degraded brief).

### Planner circuit-breaker (`start-research`)

Defined in `src/tools/start-research.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `PLANNER_FAILURE_THRESHOLD` | 2 | Consecutive planner failures before gating the brief |
| `PLANNER_FAILURE_TTL_MS` | 60 000 | Gate only holds for 60s after the last failure |

When tripped, `start-research` skips the goal-tailored brief and emits the static playbook with a footer explaining the degraded state. Counter exposed at `health://status` as `consecutive_planner_failures`.

---

## 7. Error codes

From `src/utils/errors.ts` — every tool handler ultimately routes caught errors through `classifyError()`:

| Code | Retryable | Typical trigger |
|---|---|---|
| `RATE_LIMITED` | yes | HTTP 429, "rate limit exceeded" |
| `TIMEOUT` | yes | AbortError, HTTP 408/504, `ETIMEDOUT`, stall protection |
| `NETWORK_ERROR` | yes | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND` |
| `SERVICE_UNAVAILABLE` | yes | HTTP 502/503/510, generic 5xx |
| `AUTH_ERROR` | no | HTTP 401, "Invalid API key" |
| `INVALID_INPUT` | no | HTTP 400, generic 4xx |
| `NOT_FOUND` | no | HTTP 404 |
| `QUOTA_EXCEEDED` | no | HTTP 403 |
| `INTERNAL_ERROR` | yes | HTTP 500 |
| `PARSE_ERROR` | no | JSON/schema parse failure |
| `UNKNOWN_ERROR` | no | catch-all fallback |

Retryable statuses used by `withStallProtection` and retry utilities: `[408, 429, 500, 502, 503, 504, 510]`.

---

## 8. Provider constants

### Reddit (`src/config/index.ts`)

| Constant | Value |
|---|---|
| `BATCH_SIZE` | 10 |
| `MAX_WORDS_PER_POST` | 50 000 |
| `MAX_WORDS_TOTAL` | 500 000 |
| `MIN_POSTS` / `MAX_POSTS` | 1 / 50 |
| `RETRY_COUNT` | 5 |
| `RETRY_DELAYS` (ms) | `[2000, 4000, 8000, 16000, 32000]` |

### CTR weights (URL ranking in `web-search`)

| Rank | Weight | Rank | Weight |
|---|---|---|---|
| 1 | 100.00 | 6 | 26.44 |
| 2 | 60.00 | 7 | 24.44 |
| 3 | 48.89 | 8 | 17.78 |
| 4 | 33.33 | 9 | 13.33 |
| 5 | 28.89 | 10 | 12.56 |

### Scraper (`src/config/index.ts`)

| Constant | Value |
|---|---|
| `BATCH_SIZE` | 30 |
| `EXTRACTION_PREFIX` | `"Extract from document only — never hallucinate or add external knowledge."` |
| `EXTRACTION_SUFFIX` | `"First line = content, not preamble. No confirmation messages."` |

---

## 9. TypeScript conventions

- Strict mode: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- ES modules (`"type": "module"` in `package.json`, `NodeNext` module resolution). Import specifiers end in `.js`.
- Zod v4 for all runtime schema validation (schemas in `src/schemas/`).
- Tool identifiers are kebab-case (`web-search`, not `webSearch`).
- Node.js **>= 20.19.0** or **>= 22.12.0**.
- Commits follow Conventional Commits: `type(scope): imperative summary`. Types used in this repo: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.

---

## 10. Branch + deploy contract

- Every push to `main` triggers auto-deploy to the linked Manufact server (configured in `.mcp-use/project.json`). The GitHub webhook is sometimes flaky — if the deploy doesn't appear within ~90s, force it manually.
- After every push, verify the live `health://status.version` matches `package.json.version` (or the Manufact auto-bumped one). The auto-bump typically increments the patch (`6.0.3` → `6.0.4`).
- Force a deploy: `npx mcp-use deploy --org primary-2e5b3ad6 -y`.
- Long-running feature work happens on a branch in a worktree at `/Users/yigitkonur/dev/mcp-researchpowerpack-http-revisions/`.
- Never push to `main` without running the verification chain in §11.
- Never push with `--no-verify`, `--force`, or `--no-gpg-sign` unless the user explicitly says so.

---

## 11. Before you push

```bash
pnpm typecheck   # tsc --noEmit, strict mode
pnpm test:unit   # node:test across tests/*.test.ts
pnpm test:http   # spawns server on :3000 and exercises tools/list, prompts, resources, schemas
```

All three must pass. Fix before pushing.

---

## 12. After you push — verify online with `test-by-mcpc-cli`

Install the skill if missing:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /test-by-mcpc-cli
```

### Standard smoke test

```bash
mcpc connect "https://research.yigitkonur.com/mcp" @rp
mcpc @rp ping
mcpc @rp tools-list --full | grep -E "name|requires"
mcpc @rp resources-read health://status
mcpc @rp tools-call start-research '{"goal":"smoke test"}'
mcpc @rp close
```

### Acceptance criteria (v6+)

| Check | Expected |
|---|---|
| `tools-list` count | exactly **3** — `start-research`, `web-search`, `scrape-links`. No `get-reddit-post`, no `search-reddit`. |
| `web-search` schema | exposes `scope: "web" \| "reddit" \| "both"` and `verbose: bool` |
| `health://status` body | includes `llm_planner_ok`, `llm_extractor_ok`, `planner_configured`, `extractor_configured`, `consecutive_planner_failures`, `consecutive_extractor_failures` |
| `initialize.capabilities` | includes `experimental.research_powerpack.{planner_available, extractor_available, planner_model, extractor_model}` |
| `start-research` body | starts with the `run-research` skill install hint |
| `start-research` (no LLM) | emits the compact degraded stub with a footer, not the full goal-tailored brief |
| `scrape-links` with a Reddit URL | routes via Reddit API; does NOT return `UNSUPPORTED_URL_TYPE` (that was v5 behaviour — v6 handles Reddit directly) |
| `scrape-links` with a non-Reddit URL + LLM on | returns cleaned markdown with non-zero extraction credits |
| `scrape-links` with a `.pdf` URL | routes via Jina Reader (`r.jina.ai`); returns non-empty markdown. Pre-fetch extension gate skips Scrape.do entirely. Also works for `.docx`, `.pptx`, `.xlsx`. |
| `scrape-links` with a URL whose server returns `Content-Type: application/pdf` | Scrape.do emits `UNSUPPORTED_BINARY_CONTENT` → handler reroutes through Jina Reader → returns markdown. No mojibake/binary garbage in output. |

The `/health` HTTP endpoint may return a simplified `{status, timestamp}` if the deployment is behind a proxy (e.g. Cloudflare). The MCP `health://status` resource bypasses that and returns the full payload.

---

## 13. Companion skill — `run-research`

The [`run-research` skill](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/run-research) teaches an agent how to spend these tools. Install once per machine:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /run-research
```

The `start-research` tool body starts with an install hint that links back to this skill.

---

## 14. Agent operating loop

1. **Read** — this file, `CHANGELOG.md`, and `README.md`. Treat `docs/code-review/context/*` as archived v4/v5 review evidence unless a task explicitly asks you to update or quote that history.
2. **Plan** — write a task list (max 30 tasks, one active at a time, every task ends with `commit changes`). Outcome-first names.
3. **Implement** — strict mode, kebab-case tool names, never throw from tool handlers, route failures through `toolFailure(...)`.
4. **Verify locally** — typecheck + unit + http per §11.
5. **Commit + push** — small, intentional commits; Conventional Commits format.
6. **Verify online** — `mcpc` probe per §12.
7. **Stop** — only when every acceptance criterion is green on the live URL.

---

## 15. Don'ts

- Do not add new tools without explicit user direction.
- Do not re-add `get-reddit-post` or `search-reddit`. Reddit discovery in `scrape-links` (scope + URL routing) is the contract.
- Do not add legacy env-var alias fallbacks. `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` are read directly — that's the contract.
- Do not set `reasoning_effort` from env — it is hardcoded to `'low'`.
- Do not pass Reddit URLs to `scrape-links` as "unsupported" — v6 handles them.
- Do not add cookie-cutter "Next Steps" footers with literal `[...]` placeholders.
- Do not commit `.env` or any file containing `LLM_API_KEY` / `SERPER_API_KEY` / `REDDIT_CLIENT_SECRET` / `SCRAPEDO_API_KEY`.
- Do not edit `dist/` by hand — it is regenerated by `pnpm build`.

---

## 16. Where to look first

| Need | File |
|---|---|
| Current architecture and tool contract | `AGENTS.md` sections 1-8 |
| Deploy and verification contract | `AGENTS.md` sections 10-12 |
| Public README | `README.md` |
| Env template | `.env.example` |

The `docs/code-review/context/*.md` files are archived v4/v5 review evidence.
They intentionally remain available for historical context, but they are not
current contributor guidance and must not be used as the v6 tool contract.
