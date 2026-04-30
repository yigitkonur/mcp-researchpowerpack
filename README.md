[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/yigitkonur-mcp-researchpowerpack-badge.png)](https://mseep.ai/app/yigitkonur-mcp-researchpowerpack)

# mcp-researchpowerpack

HTTP MCP server for research. Three tools, orientation-first, built for agents that run multi-pass research loops.

Built on [mcp-use](https://github.com/nicepkg/mcp-use). No stdio, HTTP only.

## tools

| tool | what it does | needs |
|------|-------------|-------|
| `start-research` | returns a goal-tailored brief: `primary_branch` (reddit / web / both), exact `first_call_sequence`, 25–50 keyword seeds, iteration hints, gaps to watch, stop criteria. Call FIRST every session. | `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` for non-degraded brief generation (optional) |
| `web-search` | parallel Google search, up to 50 queries per call, parallel-callable across turns. `scope: "web" \| "reddit" \| "both"` — reddit mode filters to post permalinks. Returns tiered markdown (HIGHLY_RELEVANT / MAYBE_RELEVANT / OTHER) + grounded synthesis + gaps + refine suggestions. | `SERPER_API_KEY` |
| `scrape-links` | fetch URLs in parallel with per-URL LLM extraction. Auto-detects `reddit.com/r/.../comments/` permalinks and routes them through the Reddit API (threaded post + comments); PDF / DOCX / PPTX / XLSX URLs route through Jina Reader; non-reddit, non-document web URLs flow through Scrape.do. Parallel-callable. | `SCRAPEDO_API_KEY` for web URLs (+ `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` for reddit URLs; optional `JINA_API_KEY` for higher document limits) |

Also exposes `/health` and `health://status`.

## workflow

Call `start-research` once at the beginning of each session with your goal. The server returns a brief that tells the agent exactly which tool to call first (reddit-first for sentiment/migration, web-first for spec/bug/pricing, both when opinion-heavy AND needs official sources), what keyword seeds to fire, and when to stop.

Pair the server with the [`run-research`](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/run-research) skill for the full agentic playbook:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /run-research
```

## quickstart

```bash
# from npm
HOST=127.0.0.1 PORT=3000 npx -y mcp-researchpowerpack

# from source
git clone https://github.com/yigitkonur/mcp-researchpowerpack.git
cd mcp-researchpowerpack
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

### providers

| var | enables |
|-----|---------|
| `SERPER_API_KEY` | `web-search` (all scopes) |
| `SCRAPEDO_API_KEY` | `scrape-links` for non-reddit, non-document web URLs |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `scrape-links` for reddit.com permalinks (threaded post + comments) |
| `JINA_API_KEY` | optional higher-rate `scrape-links` document conversion for PDF / DOCX / PPTX / XLSX URLs via Jina Reader |
| `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` | goal-tailored brief, AI extraction, search classification, raw-mode refine suggestions |

### llm (AI extraction + classification)

Any OpenAI-compatible endpoint. `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` are all required together. Reasoning effort is always `low`.

| var | required? | |
|-----|-----------|---|
| `LLM_API_KEY` | yes | API key for the endpoint |
| `LLM_BASE_URL` | yes | base URL for the OpenAI-compatible endpoint (e.g. `https://server.up.railway.app/v1`) |
| `LLM_MODEL` | yes | primary model (e.g. `gpt-5.4-mini`) |
| `LLM_FALLBACK_MODEL` | no | model to use after primary exhausts all retries — gets 3 additional attempts (e.g. `gpt-5.4`) |
| `LLM_CONCURRENCY` | no (default `50`) | parallel LLM calls |

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

Deploy to Manufact Cloud via the `mcp-use` CLI (GitHub-backed):

```bash
pnpm deploy       # runs the package script: mcp-use deploy
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
  clients/               provider API clients (serper, reddit, scrapedo, jina)
  tools/
    registry.ts          registerAllTools() — wires 3 tools
    start-research.ts    goal-tailored brief + static playbook
    search.ts            web-search handler (with CTR-weighted URL aggregation + LLM classification)
    scrape.ts            scrape-links handler (reddit + web + document branches in parallel)
    mcp-helpers.ts       response builders (markdown + structured MCP output)
    utils.ts             shared formatters
  services/
    llm-processor.ts     AI extraction, classification, brief generation — primary + fallback model, always low reasoning
    markdown-cleaner.ts  HTML/markdown cleanup
  schemas/               zod v4 input validation per tool
  utils/
    sanitize.ts          strips URL/control-char injection from follow-up suggestions
    errors.ts            structured error codes (retryable classification)
    concurrency.ts       pMap/pMapSettled — thin wrappers over p-map@7
    retry.ts             exponential backoff with jitter
    url-aggregator.ts    CTR-weighted URL ranking for search consensus
    response.ts          formatSuccess/formatError/formatBatchHeader
    logger.ts            mcpLog() — stderr-only (MCP-safe)
```

Key patterns: capability detection at startup, description-led tool routing (no bootstrap gate), always-on structured MCP tool output, tiered classified output in `web-search`, parallel reddit + web + document branches in `scrape-links`, Jina fallback for binary/document content, bounded concurrency via `p-map`, CTR-based URL ranking, tools never throw (always return `toolFailure`), and structured errors with retry classification.

## license

MIT
