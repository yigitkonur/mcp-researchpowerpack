# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP Research Powerpack HTTP — an HTTP-first MCP server built on `mcp-use` that exposes 4 research tools: `web-search`, `search-reddit`, `get-reddit-post`, and `scrape-links`. ES module TypeScript codebase, published to npm.

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Local dev with watch (mcp-use dev, serves on :3000/mcp)
pnpm build                # Compile TypeScript → dist/ (mcp-use build)
pnpm start                # Run compiled server
pnpm typecheck            # tsc --noEmit (strict mode)
pnpm test                 # HTTP integration test (spawns server, validates tools + health)
pnpm inspect              # Launch mcp-use inspector against localhost:3000/mcp
pnpm deploy               # Deploy to Manufact Cloud
```

Single test file: `tsx tests/http-server.ts`. No unit test framework — the test spawns the server process and validates tool discovery and health endpoints over HTTP.

## Architecture

```
index.ts                     Entry point: server startup, CORS, health, graceful shutdown
src/
  config/index.ts            Central config: env parsing, capability detection, constants
  clients/                   Provider API clients (search, reddit, scraper)
  tools/
    registry.ts              registerAllTools() — wires all 4 tools to the MCP server
    search.ts, reddit.ts,    Individual tool handlers
    scrape.ts
    mcp-helpers.ts           MCP response builders (markdown(), error(), toolFailure())
    utils.ts                 Shared formatters, token budget allocation
  services/
    llm-processor.ts         AI extraction/synthesis via configurable LLM endpoint
    markdown-cleaner.ts      HTML/markdown cleanup
  schemas/                   Zod input validation schemas per tool
  utils/
    errors.ts                Structured error codes with retryable classification
    concurrency.ts           pMap/pMapSettled — bounded parallel execution
    retry.ts                 Exponential backoff with jitter
    url-aggregator.ts        CTR-weighted URL ranking for web-search consensus
    response.ts              formatSuccess/formatError/formatBatchHeader
    logger.ts                mcpLog() — stderr-only logging (MCP-safe)
  version.ts                 Reads version from package.json at runtime
```

### Key patterns

- **Capability detection**: `src/config/index.ts` evaluates which API keys are present at startup. Missing keys disable tools gracefully (helpful error, no crash).
- **Lazy config via Proxy**: `LLM_EXTRACTION` config object uses `Proxy` for deferred env reads, allowing runtime changes without restart.
- **Bounded concurrency**: All parallel work uses `pMap`/`pMapSettled` from `src/utils/concurrency.ts` with explicit limits (scraper: 20, reddit: 10, LLM: 10).
- **Token budgeting**: Scraper allocates a fixed token budget (32K) divided dynamically across items.
- **CTR-based URL ranking**: `web-search` aggregates results across queries, scores URLs by search position weights, and marks consensus URLs (appearing in 5+ searches).
- **Tools never throw**: Every tool handler wraps in try-catch, returning `toolFailure(errorMessage)` on any error. The MCP server process never crashes from tool execution.
- **Structured errors**: `StructuredError` with `code`, `retryable`, `statusCode` fields. Clients use this to decide retry vs. fail-fast.
- **Logging to stderr only**: `mcpLog()` writes to stderr to avoid polluting the MCP stdout protocol channel.

### Provider dependencies

| Tool | Required env var(s) |
|------|---------------------|
| `web-search`, `search-reddit` | `SERPER_API_KEY` |
| `get-reddit-post` | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| `scrape-links` | `SCRAPEDO_API_KEY` |
| AI extraction + search classification | `LLM_API_KEY` (any OpenAI-compatible provider) |

### LLM configuration

All LLM env vars use the `LLM_*` prefix. Only `LLM_API_KEY` is required; everything else has defaults.

| Var | Default | |
|-----|---------|---|
| `LLM_API_KEY` | *(required)* | API key for the LLM provider |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Base URL (change for Cerebras, Together, etc.) |
| `LLM_MODEL` | `openai/gpt-5.4-mini` | Model identifier |
| `LLM_MAX_TOKENS` | `8000` | Max output tokens (1000–32000) |
| `LLM_REASONING` | `low` | `none` \| `low` \| `medium` \| `high` |
| `LLM_CONCURRENCY` | `10` | Parallel LLM calls (1–50) |

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

If you push to `main` after `pnpm deploy` linked the project, the linked Manufact server *should* redeploy automatically — verify with the smoke test below and force-deploy via `pnpm dlx mcp-use deploy --org <your-org-slug> -y` if the version drifts.

### Smoke-testing your deployment with mcpc

Replace `$MCP_URL` with the URL your deployment exposes:

```bash
mcpc connect "$MCP_URL" @rp
mcpc @rp ping                              # latency check
mcpc @rp tools-list --full                 # verify all 4 tools are present
mcpc @rp resources-read health://status    # uptime + active sessions + LLM health
mcpc close @rp
```

Expected: 4 tools (`start-research`, `web-search`, `get-reddit-post`, `scrape-links`), 1 resource (`health://status`), 2 prompts (`deep-research`, `reddit-sentiment`). Server name `mcp-researchpowerpack`, version reported in `health://status` should match `package.json.version`.
