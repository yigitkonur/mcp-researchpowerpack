# MCP Research Powerpack HTTP

HTTP-first MCP server for research workflows: web search, Reddit discovery, Reddit post mining, web scraping, and deep research. The server is built on `mcp-use`, served over `/mcp`, and intended for remote MCP clients and hosted deployment.

## Tools

| Tool | Purpose | Requires |
| --- | --- | --- |
| `web-search` | Parallel Google search across 3-100 keywords with ranked URLs | `SERPER_API_KEY` |
| `search-reddit` | Reddit-focused search across 3-50 diverse queries | `SERPER_API_KEY` |
| `get-reddit-post` | Fetch Reddit posts and comment trees from 2-50 Reddit URLs | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| `scrape-links` | Scrape 1-50 URLs with optional AI extraction | `SCRAPEDO_API_KEY` |
| `deep-research` | Run multi-question deep research with optional file attachments | `OPENROUTER_API_KEY` |

The server also exposes:

- `/health` for load balancers and deploy checks
- `health://status` as an MCP resource

## Quick Start

### Run locally from npm

```bash
HOST=127.0.0.1 PORT=3000 npx -y mcp-researchpowerpack-http
```

The MCP endpoint is available at:

```text
http://localhost:3000/mcp
```

### Run from source

```bash
git clone https://github.com/yigitkonur/mcp-researchpowerpack-http.git
cd mcp-researchpowerpack-http
pnpm install
pnpm dev
```

### Connect a client

This server is HTTP-only. Start it first, then point your MCP client at the URL.

Claude Desktop / Claude Code / Cursor-style config:

```json
{
  "mcpServers": {
    "research-powerpack-http": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Configuration

Copy `.env.example` and set only the keys you need. Missing provider keys do not crash the server; they disable the corresponding tools with graceful MCP errors.

### Server settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind host for local development |
| `MCP_URL` | unset | Public base URL override |
| `ALLOWED_ORIGINS` | unset | Comma-separated allowed origins / host validation list |
| `REDIS_URL` | unset | Enables Redis-backed sessions and distributed SSE streams |

Hosted deployments can boot without `ALLOWED_ORIGINS`, but production host validation stays disabled until you set it. For Manufact Cloud, the practical flow is: deploy once to get the assigned URL, then set `ALLOWED_ORIGINS` to that URL or to your custom domain and redeploy.

### Provider settings

| Variable | Enables |
| --- | --- |
| `SERPER_API_KEY` | `web-search`, `search-reddit` |
| `REDDIT_CLIENT_ID` | `get-reddit-post` |
| `REDDIT_CLIENT_SECRET` | `get-reddit-post` |
| `SCRAPEDO_API_KEY` | `scrape-links` |
| `OPENROUTER_API_KEY` | `deep-research`, AI extraction |
| `OPENROUTER_BASE_URL` | Alternate OpenRouter-compatible endpoint |
| `RESEARCH_MODEL` | Primary deep research model |
| `RESEARCH_FALLBACK_MODEL` | Deep research fallback model |
| `LLM_EXTRACTION_MODEL` | Model for scrape/reddit extraction |
| `DEFAULT_REASONING_EFFORT` | `low`, `medium`, or `high` |
| `DEFAULT_MAX_URLS` | Max URLs per research question |
| `API_TIMEOUT_MS` | Provider request timeout |
| `USE_CEREBRAS` | Use Cerebras for extraction when enabled |
| `CEREBRAS_API_KEY` | Cerebras API key |

## Development

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
pnpm inspect
```

`pnpm inspect` launches the standalone mcp-use inspector against `http://localhost:3000/mcp`.

## Deploy

### Manufact Cloud

```bash
pnpm install
pnpm build
pnpm deploy
```

After deploy, use the returned hosted URL:

```json
{
  "mcpServers": {
    "research-powerpack-http": {
      "url": "https://<deployment>.deploy.mcp-use.com/mcp"
    }
  }
}
```

Set one of the following in the hosted environment before starting the server:

- First deploy without `ALLOWED_ORIGINS` if the public URL is not known yet.
- After Manufact assigns the deployment URL, set:
  - `MCP_URL=https://<deployment>.deploy.mcp-use.com`
  - `ALLOWED_ORIGINS=https://<deployment>.deploy.mcp-use.com`

### Generic self-hosting

Run the server anywhere Node 20.19+ or 22.12+ is available:

```bash
pnpm build
HOST=0.0.0.0 ALLOWED_ORIGINS=https://app.example.com PORT=3000 pnpm start
```

Health check:

```bash
curl http://localhost:3000/health
```

## Breaking Changes In This Version

- The package is now HTTP-only. stdio transport was removed.
- Clients must connect by URL instead of spawning the package as a local command.
- Tool IDs are now kebab-case:
  - `web-search`
  - `search-reddit`
  - `get-reddit-post`
  - `scrape-links`
  - `deep-research`
- Cloudflare Workers support and Wrangler config were removed.

## License

MIT
