# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP Research Powerpack HTTP — an HTTP-first MCP server built on `mcp-use` that exposes 3 research tools: `start-research`, `web-search`, `scrape-links`. ES module TypeScript codebase, published to npm.

`scrape-links` auto-detects `reddit.com/r/.../comments/` permalinks and routes them through the Reddit API (threaded post + comments); every other URL flows through the HTTP scraper. The dedicated `get-reddit-post` tool was merged into `scrape-links` in v6.

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Local dev with watch (mcp-use dev, serves on :3000/mcp)
pnpm build                # Compile TypeScript → dist/ (mcp-use build)
pnpm start                # Run compiled server
pnpm typecheck            # tsc --noEmit (strict mode)
pnpm test                 # Unit tests + HTTP integration test
pnpm inspect              # Launch mcp-use inspector against localhost:3000/mcp
pnpm deploy               # Deploy to Manufact Cloud
```

Tests: `tsx --test tests/**/*.test.ts` (unit) + `tsx tests/http-server.ts` (integration — spawns the server process and validates tool discovery / health endpoints over HTTP).

## Architecture

```
index.ts                     Entry point: server startup, CORS, health, graceful shutdown
src/
  config/index.ts            Central config: env parsing, capability detection, constants
  clients/                   Provider API clients (search, reddit, scraper)
  tools/
    registry.ts              registerAllTools() — wires 3 tools + 2 prompts
    start-research.ts        goal-tailored brief + static playbook
    search.ts                web-search handler
    scrape.ts                scrape-links handler (reddit + web branches in parallel)
    mcp-helpers.ts           MCP response builders (markdown(), error(), toolFailure())
    utils.ts                 Shared formatters
  services/
    llm-processor.ts         AI extraction, classification, brief generation via OpenAI-compatible API
    markdown-cleaner.ts      HTML/markdown cleanup
  schemas/                   Zod input validation schemas per tool
  utils/
    errors.ts                Structured error codes with retryable classification
    concurrency.ts           pMap/pMapSettled — thin wrappers over p-map@7
    retry.ts                 Exponential backoff with jitter
    url-aggregator.ts        CTR-weighted URL ranking for web-search consensus
    response.ts              formatSuccess/formatError/formatBatchHeader
    logger.ts                mcpLog() — stderr-only logging (MCP-safe)
  version.ts                 Reads version from package.json at runtime
```

### Key patterns

- **Description-led tool routing**: no bootstrap gate. `start-research` is a strong recommendation via tool description, not a runtime precondition. Other tools work without it but surface worse results.
- **Capability detection**: `src/config/index.ts` evaluates which API keys are present at startup. Missing keys disable the affected tool gracefully (helpful error, no crash).
- **Required LLM env**: `LLM_API_KEY` is optional overall, but when set, `LLM_BASE_URL` and `LLM_MODEL` are required together. No OpenRouter default — you pick the endpoint.
- **Lazy config via Proxy**: `LLM_EXTRACTION` config object uses `Proxy` for deferred env reads.
- **Bounded concurrency**: All parallel work uses `pMap`/`pMapSettled` (thin wrappers over `p-map@7`) with explicit limits (scraper: 50, reddit: 50, LLM: 50).
- **Reddit + web parallelism in `scrape-links`**: Reddit branch (RedditClient) and web branch (ScraperClient) run concurrently via `Promise.all`; results merge in original input order.
- **CTR-based URL ranking**: `web-search` aggregates results across queries, scores URLs by CTR position weights (internal), and surfaces a static descending weight (`w=N`) to the LLM classifier.
- **Tools never throw**: Every tool handler wraps in try-catch, returning `toolFailure(errorMessage)` on any error.
- **Structured errors**: `StructuredError` with `code`, `retryable`, `statusCode` fields.
- **Logging to stderr only**: `mcpLog()` writes to stderr to avoid polluting the MCP stdout protocol channel.

### Provider dependencies

| Tool | Required env var(s) |
|------|---------------------|
| `start-research` | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` (for goal-tailored brief) |
| `web-search` | `SERPER_API_KEY` |
| `scrape-links` (non-reddit URLs) | `SCRAPEDO_API_KEY` |
| `scrape-links` (reddit.com permalinks) | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| AI extraction + classification | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` |

### LLM configuration

`LLM_API_KEY` is optional overall; when set, `LLM_BASE_URL` and `LLM_MODEL` are required — no defaults. `max_tokens` is never injected into chat completion request bodies (the model returns its natural max).

| Var | Required | |
|-----|----------|---|
| `LLM_API_KEY` | only for LLM features | API key for the provider |
| `LLM_BASE_URL` | yes (with LLM_API_KEY) | e.g. `https://openrouter.ai/api/v1`, `https://api.openai.com/v1`, `https://api.cerebras.ai/v1` |
| `LLM_MODEL` | yes (with LLM_API_KEY) | model identifier your endpoint accepts |
| `LLM_REASONING` | no — default `none` | `none \| low \| medium \| high` — opt-in per endpoint |
| `LLM_CONCURRENCY` | no — default `50` | Parallel LLM calls (1–200) |

Legacy names (`LLM_EXTRACTION_*`, `OPENROUTER_*`) still work as fallbacks.

## TypeScript conventions

- Strict mode with `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- ES modules (`"type": "module"` in package.json, `NodeNext` module resolution)
- Zod v4 for runtime schema validation (schemas in `src/schemas/`)
- Tool identifiers use kebab-case (`web-search`, not `webSearch`)
- Node.js >=20.19.0 or >=22.12.0


## Build (remote — Mac mini)

All builds run on the Mac mini. Never build locally.

```
make up        # sync + build on mini (~7s incremental)
make test      # run tests on mini
make dev       # start MCP dev server on mini
make deploy    # deploy from mini
make info      # show detected config
```

## Cloud deployment

This is a self-hosted MCP server. Deploy your own — there is no canonical hosted instance. Streamable HTTP transport, MCP protocol version `2025-11-25`.

```bash
pnpm build
pnpm deploy        # links to your Manufact account (mcp-use cloud)
```

Or self-host anywhere with Node 20.19+ / 22.12+:

```bash
HOST=0.0.0.0 ALLOWED_ORIGINS=https://app.example.com pnpm start
```

### Smoke-testing your deployment with mcpc

Replace `$MCP_URL` with the URL your deployment exposes:

```bash
mcpc connect "$MCP_URL" @rp
mcpc @rp ping                              # latency check
mcpc @rp tools-list --full                 # verify all 3 tools are present
mcpc @rp resources-read health://status    # uptime + active sessions + LLM health
mcpc close @rp
```

Expected: 3 tools (`start-research`, `web-search`, `scrape-links`), 1 resource (`health://status`), 2 prompts (`deep-research`, `reddit-sentiment`). Server name `mcp-researchpowerpack`, version reported in `health://status` should match `package.json.version`.
