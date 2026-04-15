# mcp-researchpowerpack

HTTP MCP server for research. Orientation-first search, Reddit mining, and scraping — all over `/mcp`.

Built on [mcp-use](https://github.com/nicepkg/mcp-use). No stdio, HTTP only.

## tools

| tool | what it does | needs |
|------|-------------|-------|
| `start-research` | one-time orientation step that unlocks the research workflow for the current conversation/session | none |
| `web-search` | parallel Google search across 1–100 queries with URL aggregation, signals, and follow-up suggestions | `SERPER_API_KEY` |
| `search-reddit` | Reddit-focused search across 1–100 queries | `SERPER_API_KEY` |
| `get-reddit-post` | fetch 1–100 Reddit posts with full comment trees | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| `scrape-links` | scrape 1–100 URLs with optional LLM extraction | `SCRAPEDO_API_KEY` |

Also exposes `/health`, `health://status`, and two optional MCP prompts: `deep-research` and `reddit-sentiment`.

## workflow

Call `start-research` once at the beginning of each conversation/session.

It returns the orientation brief that teaches how to route between:

- `web-search`
- `search-reddit`
- `get-reddit-post`
- `scrape-links`

All four research tools are gated until that orientation step has happened for the current workflow key.

## quickstart

```bash
# from npm
HOST=127.0.0.1 PORT=3000 npx -y mcp-researchpowerpack-http

# from source
git clone https://github.com/yigitkonur/mcp-researchpowerpack-http.git
cd mcp-researchpowerpack-http
pnpm install && pnpm dev
```

Connect your client to `http://localhost:3000/mcp`:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## config

Copy `.env.example`, set only what you need. Missing keys don't crash the server — they disable the affected capability with a clear error.

### server

| var | default | |
|-----|---------|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | bind address |
| `ALLOWED_ORIGINS` | unset | comma-separated origins for host validation |
| `MCP_URL` | unset | fallback public MCP URL used by the production origin-protection guard |
| `REDIS_URL` | unset | Redis-backed MCP sessions, distributed SSE, and workflow state |

### providers

| var | enables |
|-----|---------|
| `SERPER_API_KEY` | `web-search`, `search-reddit` |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `get-reddit-post` |
| `SCRAPEDO_API_KEY` | `scrape-links` |
| `LLM_API_KEY` | AI extraction, search classification, and raw-mode refine suggestions |

### llm (AI extraction + classification)

Any OpenAI-compatible provider works — OpenRouter, Cerebras, Together, etc.

| var | default | |
|-----|---------|---|
| `LLM_API_KEY` | *(required for LLM features)* | API key for the LLM provider |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | base URL |
| `LLM_MODEL` | `openai/gpt-5.4-mini` | model identifier |
| `LLM_MAX_TOKENS` | `8000` | max output tokens |
| `LLM_REASONING` | `low` | `none` \| `low` \| `medium` \| `high` |
| `LLM_CONCURRENCY` | `50` | parallel LLM calls |

### evals

`pnpm test:evals` writes a JSON artifact to `test-results/eval-runs/<timestamp>.json`.

When an OpenAI API key is present, it performs a live Responses API + remote MCP evaluation.
Without an API key, it exits successfully in explicit skip mode and records that skip in the artifact.

Useful env vars:

- `EVAL_MCP_URL`
- `EVAL_MODEL`
- `EVAL_API_KEY` or `OPENAI_API_KEY`

## dev

```bash
pnpm install
pnpm dev          # watch mode, serves :3000/mcp
pnpm typecheck    # tsc --noEmit
pnpm test         # unit + http integration tests
pnpm build        # compile to dist/
pnpm inspect      # mcp-use inspector
```

## deploy

```bash
pnpm build
pnpm deploy       # manufact cloud
```

Or self-host anywhere with Node 20.19+ / 22.12+:

```bash
HOST=0.0.0.0 ALLOWED_ORIGINS=https://app.example.com pnpm start
```

## architecture

```
index.ts                 server startup, cors, health, shutdown
src/
  config/                env parsing, capability detection, lazy proxy config
  clients/               provider API clients (serper, reddit, scrapedo)
  prompts/               optional MCP prompts for deep-research and reddit-sentiment
  tools/
    registry.ts          registerAllTools() — wires tools to MCP server
    start-research.ts    workflow orientation entrypoint
    search.ts            web-search handler
    reddit.ts            search-reddit + get-reddit-post
    scrape.ts            scrape-links handler
    mcp-helpers.ts       response builders (markdown + structured MCP output)
    utils.ts             shared formatters, token budget allocation
  services/
    workflow-state.ts    conversation-aware workflow state with memory/Redis backends
    llm-processor.ts     AI extraction/synthesis via OpenAI-compatible API
    markdown-cleaner.ts  HTML/markdown cleanup
  schemas/               zod v4 input validation per tool
  utils/
    workflow-key.ts      workflow identity derivation from user/session context
    bootstrap-guard.ts   hard gate enforcing start-research first
    reddit-keyword-guard.ts  one-shot redirect for reddit-first web-search misuse
    sanitize.ts          strips URL/control-char injection from follow-up suggestions
    errors.ts            structured error codes (retryable classification)
    concurrency.ts       pMap/pMapSettled — bounded parallel execution
    retry.ts             exponential backoff with jitter
    url-aggregator.ts    CTR-weighted URL ranking for search consensus
    response.ts          formatSuccess/formatError/formatBatchHeader
    logger.ts            mcpLog() — stderr-only (MCP-safe)
```

Key patterns: capability detection at startup, conversation-aware workflow gating via `start-research`, always-on structured MCP tool output, raw and classified follow-up guidance in `web-search`, bounded concurrency, CTR-based URL ranking, tools never throw (always return `toolFailure`), and structured errors with retry classification.

## license

MIT
