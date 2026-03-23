# CLAUDE.md

This file provides guidance to coding agents working in this repository.

## What This Is

HTTP-only MCP server built on `mcp-use`. It exposes 5 research tools over `/mcp`:

- `web-search`
- `search-reddit`
- `get-reddit-post`
- `scrape-links`
- `deep-research`

There is no stdio transport and no Cloudflare worker target anymore.

## Build, Run, Test

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
pnpm inspect
```

Useful local run:

```bash
PORT=3000 HOST=127.0.0.1 pnpm start
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

## Important Environment Variables

Server:

- `PORT`
- `HOST`
- `MCP_URL`
- `ALLOWED_ORIGINS`
- `REDIS_URL`

Production can boot without `ALLOWED_ORIGINS`, but host validation stays disabled until it is set. For Manufact Cloud, deploy once to get the assigned URL, then set `ALLOWED_ORIGINS` to that URL or your custom domain and redeploy.

Providers:

- `SERPER_API_KEY`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `SCRAPEDO_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `RESEARCH_MODEL`
- `RESEARCH_FALLBACK_MODEL`
- `LLM_EXTRACTION_MODEL`
- `DEFAULT_REASONING_EFFORT`
- `DEFAULT_MAX_URLS`
- `API_TIMEOUT_MS`
- `USE_CEREBRAS`
- `CEREBRAS_API_KEY`

Missing provider keys should disable the corresponding tool gracefully rather than crashing the server.

## Architecture

```text
index.ts                     Root HTTP server entrypoint (mcp-use)
src/
  config/index.ts            Env parsing, capability detection, runtime constants
  version.ts                 Version + package metadata loader
  clients/                   External API integrations
  tools/registry.ts          Registers all tools on MCPServer
  tools/search.ts            web-search handler + registration
  tools/reddit.ts            search-reddit / get-reddit-post handlers + registration
  tools/scrape.ts            scrape-links handler + registration
  tools/research.ts          deep-research handler + registration
  tools/mcp-helpers.ts       Explicit tool result helpers, response adapters, progress reporters
  schemas/                   Zod v4 input schemas
  services/                  Shared LLM/file/markdown services
  utils/                     Logging, retries, concurrency, formatting, error classification
tests/http-server.ts         End-to-end HTTP integration test
```

## Repo Rules

- Keep imports ESM-safe with `.js` extensions.
- Tool registration should happen via `server.tool(...)`, not raw SDK request handlers.
- Prefer capability checks with `getCapabilities()` / `getMissingEnvMessage()` before calling providers.
- Keep graceful shutdown intact in `index.ts`.
- If you add a new tool, update:
  - server registration
  - README
  - `.env.example` if new env vars are needed
  - `tests/http-server.ts` if the public MCP surface changes

## Current Validation Path

`pnpm test` boots the HTTP server and checks:

- `/health`
- MCP `initialize`
- `tools/list`
- `resources/read` for `health://status`
- invalid tool input handling
- missing capability handling
