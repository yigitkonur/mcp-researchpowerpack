# mcp-researchpowerpack

http mcp server for research. web search, reddit mining, and scraping — all over `/mcp`.

built on [mcp-use](https://github.com/nicepkg/mcp-use). no stdio, http only.

## tools

| tool | what it does | needs |
|------|-------------|-------|
| `web-search` | parallel google search across 1–100 queries, ctr-weighted url ranking | `SERPER_API_KEY` |
| `search-reddit` | reddit-focused search, 3–50 diverse queries | `SERPER_API_KEY` |
| `get-reddit-post` | fetch reddit posts + full comment trees, 2–50 urls | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| `scrape-links` | scrape 1–50 urls with optional ai extraction | `SCRAPEDO_API_KEY` |

also exposes `/health` and `health://status` mcp resource.

## quickstart

```bash
# from npm
HOST=127.0.0.1 PORT=3000 npx -y mcp-researchpowerpack-http

# from source
git clone https://github.com/yigitkonur/mcp-researchpowerpack-http.git
cd mcp-researchpowerpack-http
pnpm install && pnpm dev
```

connect your client to `http://localhost:3000/mcp`:

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

copy `.env.example`, set only what you need. missing keys don't crash — they disable the tool with a clear error.

### server

| var | default | |
|-----|---------|---|
| `PORT` | `3000` | http port |
| `HOST` | `127.0.0.1` | bind address |
| `ALLOWED_ORIGINS` | unset | comma-separated origins for host validation |
| `REDIS_URL` | unset | redis-backed sessions + distributed sse |

### providers

| var | enables |
|-----|---------|
| `SERPER_API_KEY` | web-search, search-reddit |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | get-reddit-post |
| `SCRAPEDO_API_KEY` | scrape-links |

### llm (ai extraction + search classification)

any openai-compatible provider works — openrouter, cerebras, together, etc.

| var | default | |
|-----|---------|---|
| `LLM_API_KEY` | *(required)* | api key for the llm provider |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | base url (change for other providers) |
| `LLM_MODEL` | `openai/gpt-5.4-mini` | model identifier |
| `LLM_MAX_TOKENS` | `8000` | max output tokens (1000–32000) |
| `LLM_REASONING` | `low` | `none` \| `low` \| `medium` \| `high` |
| `LLM_CONCURRENCY` | `10` | parallel llm calls (1–50) |

<details>
<summary>legacy env var names (still work, prefer the new names above)</summary>

| old name | new name |
|----------|----------|
| `OPENROUTER_API_KEY` | `LLM_API_KEY` |
| `OPENROUTER_BASE_URL` | `LLM_BASE_URL` |
| `LLM_EXTRACTION_API_KEY` | `LLM_API_KEY` |
| `LLM_EXTRACTION_BASE_URL` | `LLM_BASE_URL` |
| `LLM_EXTRACTION_MODEL` | `LLM_MODEL` |
| `LLM_EXTRACTION_MAX_TOKENS` | `LLM_MAX_TOKENS` |
| `LLM_EXTRACTION_REASONING` | `LLM_REASONING` |
| `LLM_EXTRACTION_CONCURRENCY` | `LLM_CONCURRENCY` |

fallback priority: `LLM_*` → `LLM_EXTRACTION_*` → `OPENROUTER_*` (for api key and base url only).

</details>

## dev

```bash
pnpm install
pnpm dev          # watch mode, serves :3000/mcp
pnpm typecheck    # tsc --noEmit
pnpm test         # http integration test
pnpm build        # compile to dist/
pnpm inspect      # mcp-use inspector
```

## deploy

```bash
pnpm build
pnpm deploy       # manufact cloud
```

or self-host anywhere with node 20.19+ / 22.12+:

```bash
HOST=0.0.0.0 ALLOWED_ORIGINS=https://app.example.com pnpm start
```

## architecture

```
index.ts                 server startup, cors, health, shutdown
src/
  config/                env parsing, capability detection, lazy proxy config
  clients/               provider api clients (serper, reddit, scrapedo)
  tools/
    registry.ts          registerAllTools() — wires tools to mcp server
    search.ts            web-search handler
    reddit.ts            search-reddit + get-reddit-post
    scrape.ts            scrape-links handler
    mcp-helpers.ts       response builders (markdown, error, toolFailure)
    utils.ts             shared formatters, token budget allocation
  services/
    llm-processor.ts     ai extraction/synthesis via openai-compatible api
    markdown-cleaner.ts  html/markdown cleanup
  schemas/               zod v4 input validation per tool
  utils/
    errors.ts            structured error codes (retryable classification)
    concurrency.ts       pMap/pMapSettled — bounded parallel execution
    retry.ts             exponential backoff with jitter
    url-aggregator.ts    ctr-weighted url ranking for search consensus
    response.ts          formatSuccess/formatError/formatBatchHeader
    logger.ts            mcpLog() — stderr-only (mcp-safe)
```

key patterns: capability detection at startup, lazy config via proxy, bounded concurrency (scraper:20, reddit:10, llm:10), 32k token budgets, ctr-based url ranking, tools never throw (always return toolFailure), structured errors with retry classification.

## license

mit
