# mcp-researchpowerpack

Five parallel research tools in one MCP server: Google search, Reddit mining, web scraping with AI extraction, deep research with web search, and Reddit post fetching with comment analysis.

All tools run through [OpenRouter](https://openrouter.ai) for AI capabilities. The server uses **x-ai/grok-4.1-fast** for deep research (with web search) and **openai/gpt-oss-120b:nitro** for content extraction.

[![npm](https://img.shields.io/npm/v/mcp-researchpowerpack)](https://www.npmjs.com/package/mcp-researchpowerpack)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Quick Start

### npx (no install)

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["-y", "mcp-researchpowerpack"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-...",
        "SERPER_API_KEY": "...",
        "SCRAPEDO_API_KEY": "...",
        "REDDIT_CLIENT_ID": "...",
        "REDDIT_CLIENT_SECRET": "..."
      }
    }
  }
}
```

### Global install

```bash
npm install -g mcp-researchpowerpack
```

Then add to your MCP client config:

```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "mcp-researchpowerpack",
      "env": {
        "OPENROUTER_API_KEY": "sk-or-...",
        "SERPER_API_KEY": "...",
        "SCRAPEDO_API_KEY": "...",
        "REDDIT_CLIENT_ID": "...",
        "REDDIT_CLIENT_SECRET": "..."
      }
    }
  }
}
```

## Tools

### search_google

Parallel Google search across 3-100 keywords with CTR-weighted ranking and consensus detection.

```
search_google({ keywords: ["MCP protocol", "model context protocol tutorial", "MCP vs function calling"] })
```

- 10 results per keyword, aggregated by frequency and position
- Supports operators: `site:`, `"exact phrase"`, `-exclude`, `filetype:`, `OR`
- **Requires:** `SERPER_API_KEY`

### search_reddit

Discovery search across 3-50 queries, returns Reddit post URLs for `fetch_reddit`.

```
search_reddit({ queries: ["best MCP servers 2025", "MCP setup guide", "r/ClaudeAI MCP"] })
```

- Auto-adds `site:reddit.com`
- Supports: `intitle:`, `"exact"`, `OR`, `-exclude`
- **Requires:** `SERPER_API_KEY`

### fetch_reddit

Fetch 2-50 Reddit posts with full comment trees and optional AI summarization.

```
fetch_reddit({
  urls: ["https://reddit.com/r/ClaudeAI/comments/...", "https://reddit.com/r/LocalLLaMA/comments/..."],
  fetch_comments: true,
  max_comments: 100
})
```

- Smart comment budget: 1000 total distributed across posts (2 posts = 500 each, 10 = 100 each)
- Phase 2 redistribution: unused comment budget from short posts flows to truncated ones
- Optional `use_llm: true` for AI synthesis of discussions
- **Requires:** `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`

### scrape_pages

Scrape 1-50 URLs with optional AI-powered content extraction.

```
scrape_pages({
  urls: ["https://docs.example.com/api", "https://example.com/pricing"],
  use_llm: true,
  what_to_extract: "pricing tiers | API limits | authentication methods"
})
```

- `use_llm: true` (default) — strips nav/ads/footers, extracts only what you specify
- 32K token budget distributed across URLs
- Model override: `"openai/gpt-oss-120b:nitro"` (default) or `"x-ai/grok-4.1-fast"` (adds web search)
- 3-mode scraper fallback: basic -> JS rendering -> JS + US geo
- **Requires:** `SCRAPEDO_API_KEY` (+ `OPENROUTER_API_KEY` for `use_llm`)

### deep_research

AI-powered research with web search, 1-10 questions processed in parallel.

```
deep_research({
  questions: [{
    question: "GOAL: Compare X vs Y. WHY: Choosing a tool. KNOWN: X is open-source. QUESTIONS: 1. Performance? 2. Cost? 3. Community?",
    file_attachments: [{ path: "/abs/path/to/file.ts", start_line: 10, end_line: 50 }]
  }]
})
```

- 32K token budget split across questions
- Uses **x-ai/grok-4.1-fast** with live web search (fallback: **openai/gpt-oss-120b:nitro**)
- File attachments for code-related questions (bugs, perf, architecture)
- **Requires:** `OPENROUTER_API_KEY`

## API Keys

| Key | Tools | Free Tier | Get It |
|-----|-------|-----------|--------|
| `SERPER_API_KEY` | search_google, search_reddit | 2,500 queries/mo | [serper.dev](https://serper.dev) |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | fetch_reddit | Unlimited | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) (select "script") |
| `SCRAPEDO_API_KEY` | scrape_pages | 1,000 credits | [scrape.do](https://scrape.do) |
| `OPENROUTER_API_KEY` | deep_research, scrape_pages (use_llm) | Pay-as-you-go | [openrouter.ai/keys](https://openrouter.ai/keys) |

All keys are optional. The server starts with whatever you provide and disables tools whose keys are missing.

## Configuration

Optional environment variables for tuning:

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEARCH_MODEL` | `x-ai/grok-4.1-fast` | Primary model for deep_research |
| `RESEARCH_FALLBACK_MODEL` | `openai/gpt-oss-120b:nitro` | Fallback when primary fails |
| `LLM_EXTRACTION_MODEL` | `openai/gpt-oss-120b:nitro` | Default model for scrape_pages extraction |
| `API_TIMEOUT_MS` | `1800000` (30 min) | Request timeout |
| `DEFAULT_REASONING_EFFORT` | `high` | Reasoning effort: low, medium, high |
| `DEFAULT_MAX_URLS` | `100` | Max search results per research question |
| `LLM_ENABLE_REASONING` | `true` | Enable reasoning in extraction |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter endpoint override |

## Backward Compatibility

Old tool names are aliased automatically:

| Old Name | New Name |
|----------|----------|
| `web_search` | `search_google` |
| `scrape_links` | `scrape_pages` |
| `get_reddit_post` | `fetch_reddit` |

## Development

```bash
git clone https://github.com/yigitkonur/mcp-researchpowerpack.git
cd mcp-researchpowerpack
pnpm install
cp .env.example .env   # fill in your API keys
pnpm build             # tsc + copy YAML config
pnpm dev               # run with tsx (hot reload)
```

### Project Structure

```
src/
├── index.ts              # MCP server entry (stdio + HTTP transports)
├── version.ts            # Version from package.json
├── config/
│   ├── index.ts          # All constants, env parsing, capability detection
│   ├── loader.ts         # YAML -> Zod -> MCP schema generator
│   └── yaml/tools.yaml   # Tool definitions (descriptions, params, limits)
├── schemas/              # Zod validation schemas
│   ├── deep-research.ts
│   ├── scrape-links.ts
│   └── web-search.ts
├── tools/
│   ├── registry.ts       # Tool registry, alias resolution, execution pipeline
│   ├── definitions.ts    # YAML -> MCP tool list
│   ├── research.ts       # deep_research handler
│   ├── scrape.ts         # scrape_pages handler
│   ├── search.ts         # search_google handler
│   ├── reddit.ts         # search_reddit + fetch_reddit handlers
│   └── utils.ts          # Token budgets, formatting helpers
├── clients/
│   ├── research.ts       # OpenRouter client (Grok/Gemini routing, retry, fallback)
│   ├── scraper.ts        # Scrape.do client (3-mode fallback, retry)
│   ├── search.ts         # Serper.dev client (batch search, Reddit search)
│   └── reddit.ts         # Reddit OAuth client (comment redistribution)
├── services/
│   ├── llm-processor.ts  # LLM extraction (model routing, retry)
│   ├── markdown-cleaner.ts # HTML -> Markdown (Turndown)
│   └── file-attachment.ts  # File reader for research attachments
└── utils/
    ├── errors.ts         # Error classification and retry logic
    ├── concurrency.ts    # pMap / pMapSettled (bounded concurrency)
    ├── url-aggregator.ts # CTR-weighted URL ranking
    ├── response.ts       # 70/20/10 response formatting
    ├── logger.ts         # MCP structured logging
    └── markdown-formatter.ts
```

### Key Design Decisions

- **Never crashes**: Every handler catches all errors and returns structured error responses
- **Capability-based degradation**: Missing API keys disable tools gracefully, not crash the server
- **Bounded concurrency**: All parallel operations use `pMap` with limits (3 for LLM, 10 for Reddit, 30 for scraping)
- **Model routing**: xAI models get `search_parameters`, Gemini models get `google_search` tool, others get standard completions
- **Two allowed models**: `openai/gpt-oss-120b:nitro` for extraction, `x-ai/grok-4.1-fast` for research with web search

## Publishing

This package uses GitHub Actions with npm OIDC provenance for publishing.

### Setup (one-time)

1. Create an npm granular access token for `mcp-researchpowerpack` at [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens/granular-access-tokens/new)
2. Add it as `NPM_TOKEN` secret in the GitHub repo: Settings -> Secrets -> Actions -> New repository secret
3. Push to `main` — the CI workflow auto-bumps the version and publishes with provenance

### Manual publish

```bash
pnpm build
npm publish --access public --provenance
```

### CI Workflow

On every push to `main`:
1. Installs dependencies, builds TypeScript
2. Checks if current version exists on npm
3. If it exists: auto-bumps patch version, commits with `[skip ci]`, pushes tag
4. Publishes with `--provenance` (OIDC attestation from GitHub Actions)

## License

MIT
