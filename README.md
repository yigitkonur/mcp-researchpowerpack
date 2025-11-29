# Research Powerpack MCP

**The ultimate research MCP toolkit** — Reddit mining, web search with CTR aggregation, AI-powered deep research, and intelligent web scraping, all in one modular package.

[![npm version](https://img.shields.io/npm/v/research-powerpack-mcp.svg)](https://www.npmjs.com/package/research-powerpack-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Why Research Powerpack?

AI coding assistants are only as good as the context they have. This MCP server gives your AI **superpowers for research**:

| Tool | What It Does | Real Value |
|------|-------------|------------|
| `web_search` | Batch Google search (up to 100 keywords) with CTR-weighted ranking | Find the most authoritative sources across multiple search angles simultaneously |
| `search_reddit` | Google-powered Reddit search with advanced operators | Discover real user discussions, opinions, and experiences |
| `get_reddit_post` | Fetch Reddit posts with smart comment allocation | Extract community wisdom with automatic comment budget distribution |
| `scrape_links` | Universal URL scraping with automatic fallback | Get full content from any webpage with JS rendering and geo-targeting |
| `deep_research` | AI-powered batch research with citations | Get comprehensive, evidence-based answers to multiple questions in parallel |

**Modular by design** — use just one tool or all five. Configure only the API keys you need.

---

## Quick Start

### 1. Install

```bash
npm install research-powerpack-mcp
```

### 2. Configure (pick what you need)

Copy `.env.example` to `.env` and add the API keys for the tools you want:

```bash
# Minimal (just web search) - FREE
SERPER_API_KEY=your_serper_key

# Full power (all 5 tools)
SERPER_API_KEY=your_serper_key
REDDIT_CLIENT_ID=your_reddit_id
REDDIT_CLIENT_SECRET=your_reddit_secret
SCRAPEDO_API_KEY=your_scrapedo_key
OPENROUTER_API_KEY=your_openrouter_key
```

### 3. Add to your MCP client

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["research-powerpack-mcp"],
      "env": {
        "SERPER_API_KEY": "your_key",
        "REDDIT_CLIENT_ID": "your_id",
        "REDDIT_CLIENT_SECRET": "your_secret",
        "SCRAPEDO_API_KEY": "your_key",
        "OPENROUTER_API_KEY": "your_key"
      }
    }
  }
}
```

**Cursor/Windsurf** (`.cursor/mcp.json` or similar):
```json
{
  "mcpServers": {
    "research-powerpack": {
      "command": "npx",
      "args": ["research-powerpack-mcp"],
      "env": {
        "SERPER_API_KEY": "your_key"
      }
    }
  }
}
```

---

## Environment Variables & Tool Availability

Research Powerpack uses a **modular architecture**. Tools are automatically enabled based on which API keys you provide:

| ENV Variable | Tools Enabled | Free Tier |
|--------------|---------------|-----------|
| `SERPER_API_KEY` | `web_search`, `search_reddit` | 2,500 queries |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `get_reddit_post` | Unlimited |
| `SCRAPEDO_API_KEY` | `scrape_links` | 1,000 credits |
| `OPENROUTER_API_KEY` | `deep_research` + AI extraction in `scrape_links` | Pay-as-you-go |

**No ENV = No crash.** The server always starts. If you call a tool without the required API key, you get a helpful error message with setup instructions.

### Configuration Examples

```bash
# Search-only mode (just web_search and search_reddit)
SERPER_API_KEY=xxx

# Reddit research mode (search + fetch posts)
SERPER_API_KEY=xxx
REDDIT_CLIENT_ID=xxx
REDDIT_CLIENT_SECRET=xxx

# Full research mode (all tools)
SERPER_API_KEY=xxx
REDDIT_CLIENT_ID=xxx
REDDIT_CLIENT_SECRET=xxx
SCRAPEDO_API_KEY=xxx
OPENROUTER_API_KEY=xxx
```

---

## API Key Setup Guides

<details>
<summary><b>🔍 Serper API (Google Search)</b></summary>

### What you get
- 2,500 free queries/month
- Fast Google search results via API
- Enables `web_search` and `search_reddit` tools

### Setup Steps
1. Go to [serper.dev](https://serper.dev)
2. Click **"Get API Key"** (top right)
3. Sign up with email or Google
4. Your API key is displayed on the dashboard
5. Copy it to your `.env`:
   ```
   SERPER_API_KEY=your_key_here
   ```

### Pricing
- **Free**: 2,500 queries/month
- **Paid**: $50/month for 50,000 queries ($0.001/query)

</details>

<details>
<summary><b>🤖 Reddit OAuth (Reddit API)</b></summary>

### What you get
- Unlimited Reddit API access
- Fetch posts and comments with upvote sorting
- Enables `get_reddit_post` tool

### Setup Steps
1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Scroll down and click **"create another app..."**
3. Fill in:
   - **Name**: `research-powerpack` (or any name)
   - **App type**: Select **"script"** (important!)
   - **Description**: Optional
   - **About URL**: Leave blank
   - **Redirect URI**: `http://localhost:8080` (required but not used)
4. Click **"create app"**
5. Copy your credentials:
   - **Client ID**: The string under your app name (e.g., `yuq_M0kWusHp2olglFBnpw`)
   - **Client Secret**: The "secret" field
6. Add to your `.env`:
   ```
   REDDIT_CLIENT_ID=your_client_id
   REDDIT_CLIENT_SECRET=your_client_secret
   ```

### Tips
- Script apps have the highest rate limits
- No user authentication required
- Works immediately after creation

</details>

<details>
<summary><b>🌐 Scrape.do (Web Scraping)</b></summary>

### What you get
- 1,000 free scraping credits
- JavaScript rendering support
- Geo-targeting and CAPTCHA handling
- Enables `scrape_links` tool

### Setup Steps
1. Go to [scrape.do](https://scrape.do)
2. Click **"Start Free"** or **"Get Started"**
3. Sign up with email
4. Your API key is on the dashboard
5. Add to your `.env`:
   ```
   SCRAPEDO_API_KEY=your_key_here
   ```

### Credit Usage
- **Basic scrape**: 1 credit
- **JavaScript rendering**: 5 credits
- **Geo-targeting**: +25 credits

### Pricing
- **Free**: 1,000 credits (renews monthly)
- **Starter**: $29/month for 100,000 credits

</details>

<details>
<summary><b>🧠 OpenRouter (AI Models)</b></summary>

### What you get
- Access to 100+ AI models via one API
- Enables `deep_research` tool
- Enables AI extraction in `scrape_links` (`use_llm`, `what_to_extract`)

### Setup Steps
1. Go to [openrouter.ai](https://openrouter.ai)
2. Click **"Sign In"** → Sign up with Google/GitHub/email
3. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
4. Click **"Create Key"**
5. Copy the key (starts with `sk-or-...`)
6. Add to your `.env`:
   ```
   OPENROUTER_API_KEY=sk-or-v1-xxxxx
   ```

### Recommended Models
The default model is `perplexity/sonar-deep-research` (optimized for research with web search).

Alternative models:
```bash
# Fast and capable
RESEARCH_MODEL=x-ai/grok-4.1-fast

# High quality
RESEARCH_MODEL=anthropic/claude-3.5-sonnet

# Budget-friendly
RESEARCH_MODEL=openai/gpt-4o-mini
```

### Pricing
- Pay-as-you-go (no subscription required)
- Prices vary by model (~$0.001-$0.03 per 1K tokens)
- `perplexity/sonar-deep-research`: ~$5 per 1M tokens

</details>

---

## Tool Reference

### `web_search`

**Batch web search** using Google via Serper API. Search up to 100 keywords in parallel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keywords` | `string[]` | Yes | Search queries (1-100). Use distinct keywords for maximum coverage. |

**Features:**
- Google search operators: `site:`, `-exclusion`, `"exact phrase"`, `filetype:`
- CTR-weighted ranking identifies high-consensus URLs
- Related search suggestions per query

**Example:**
```json
{
  "keywords": [
    "best IDE 2025",
    "VS Code alternatives",
    "Cursor vs Windsurf comparison"
  ]
}
```

---

### `search_reddit`

**Search Reddit** via Google with automatic `site:reddit.com` filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `queries` | `string[]` | Yes | Search queries (max 10). Use distinct queries for multiple perspectives. |
| `date_after` | `string` | No | Filter results after date (YYYY-MM-DD) |

**Search Operators:**
- `intitle:keyword` — Match in post title
- `"exact phrase"` — Exact match
- `OR` — Match either term
- `-exclude` — Exclude term

**Example:**
```json
{
  "queries": [
    "best mechanical keyboard 2025",
    "intitle:keyboard recommendation",
    "\"keychron\" OR \"nuphy\" review"
  ],
  "date_after": "2024-01-01"
}
```

---

### `get_reddit_post`

**Fetch Reddit posts** with smart comment allocation (1,000 comment budget distributed automatically).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | `string[]` | Yes | — | Reddit post URLs (2-50) |
| `fetch_comments` | `boolean` | No | `true` | Whether to fetch comments |
| `max_comments` | `number` | No | auto | Override comment allocation |

**Smart Allocation:**
- 2 posts: ~500 comments/post (deep dive)
- 10 posts: ~100 comments/post
- 50 posts: ~20 comments/post (quick scan)

**Example:**
```json
{
  "urls": [
    "https://reddit.com/r/programming/comments/abc123/post_title",
    "https://reddit.com/r/webdev/comments/def456/another_post"
  ],
  "fetch_comments": true
}
```

---

### `scrape_links`

**Universal URL content extraction** with automatic fallback modes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | `string[]` | Yes | — | URLs to scrape (3-50) |
| `timeout` | `number` | No | `30` | Timeout per URL (seconds) |
| `use_llm` | `boolean` | No | `false` | Enable AI extraction (requires `OPENROUTER_API_KEY`) |
| `what_to_extract` | `string` | No | — | Extraction instructions for AI |

**Automatic Fallback:**
1. Basic mode (fast)
2. JavaScript rendering (for SPAs)
3. JavaScript + US geo-targeting (for restricted content)

**Token Allocation:** 32,000 tokens distributed across URLs:
- 3 URLs: ~10,666 tokens/URL
- 10 URLs: ~3,200 tokens/URL
- 50 URLs: ~640 tokens/URL

**Example:**
```json
{
  "urls": [
    "https://example.com/article1",
    "https://example.com/article2",
    "https://example.com/article3"
  ],
  "use_llm": true,
  "what_to_extract": "Extract the main arguments, key statistics, and conclusions"
}
```

---

### `deep_research`

**AI-powered batch research** with web search and citations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `questions` | `object[]` | Yes | Research questions (2-10) |
| `questions[].question` | `string` | Yes | The research question |
| `questions[].file_attachments` | `object[]` | No | Files to include as context |

**Token Allocation:** 32,000 tokens distributed across questions:
- 2 questions: 16,000 tokens/question (deep dive)
- 5 questions: 6,400 tokens/question (balanced)
- 10 questions: 3,200 tokens/question (rapid multi-topic)

**Example:**
```json
{
  "questions": [
    {
      "question": "What are the current best practices for React Server Components in 2025? Include patterns for data fetching and caching."
    },
    {
      "question": "Compare the performance characteristics of Bun vs Node.js for production workloads. Include benchmarks and real-world case studies."
    }
  ]
}
```

---

## Recommended Workflows

### Research a Technology Decision

```
1. web_search: ["React vs Vue 2025", "Next.js vs Nuxt comparison", "frontend framework benchmarks"]
2. search_reddit: ["best frontend framework 2025", "migrating from React to Vue", "Next.js production experience"]
3. get_reddit_post: [URLs from step 2]
4. scrape_links: [Documentation and blog URLs from step 1]
5. deep_research: [Synthesize findings into specific questions]
```

### Competitive Analysis

```
1. web_search: ["competitor name review", "competitor vs alternatives", "competitor pricing"]
2. scrape_links: [Competitor websites, review sites, comparison pages]
3. search_reddit: ["competitor name experience", "switching from competitor"]
4. get_reddit_post: [URLs from step 3]
```

### Debug an Obscure Error

```
1. web_search: ["exact error message", "error message + framework name"]
2. search_reddit: ["error message", "framework + error type"]
3. get_reddit_post: [URLs with solutions]
4. scrape_links: [Stack Overflow answers, GitHub issues]
```

---

## Enable Full Power Mode

For the best research experience, configure all four API keys:

```bash
# .env
SERPER_API_KEY=your_serper_key       # Free: 2,500 queries/month
REDDIT_CLIENT_ID=your_reddit_id       # Free: Nearly unlimited
REDDIT_CLIENT_SECRET=your_reddit_secret
SCRAPEDO_API_KEY=your_scrapedo_key   # Free: 1,000 credits/month
OPENROUTER_API_KEY=your_openrouter_key # Pay-as-you-go
```

This unlocks:
- **5 research tools** working together
- **AI-powered content extraction** in scrape_links
- **Deep research with web search** and citations
- **Complete Reddit mining** (search → fetch → analyze)

Total setup time: ~10 minutes. Total free tier value: ~$50/month equivalent.

---

## Development

```bash
# Clone
git clone https://github.com/yigitkonur/research-powerpack-mcp.git
cd research-powerpack-mcp

# Install
npm install

# Development
npm run dev

# Build
npm run build

# Type check
npm run typecheck
```

---

## License

MIT © [Yiğit Konur](https://github.com/yigitkonur)
