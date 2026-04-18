# Current Tool Surface

## Purpose

Document what the server **advertises** versus what it **actually produces**, tool by tool, so every downstream work-unit can point at a concrete gap. All numbers come from a live probe of `mcp-researchpowerpack-http` v4.2.4 on 2026-04-18 (uptime 111581s, 521 active sessions).

## Tools at a glance

The server registers **5 tools**. `start-research` is the only one that bypasses `requireBootstrap()`; every other tool returns a bootstrap error until `start-research` has been called once in the session.

## 1. `start-research`

- **Schema (key params):** `goal?: string` (optional; if provided, triggers `renderResearchBrief()` via LLM planner).
- **Advertised behavior:** Bootstrap the session and produce a goal-tailored research brief plus the full static playbook.
- **Actually observed:** 4426 chars / ~1106 tokens. The brief footer reads:
  ```
  > _Goal-tailored brief unavailable: LLM planner is not configured or failed this call. The static playbook above still applies; you can proceed with it, or retry start-research after verifying LLM_API_KEY._
  ```
  The agent receives the static playbook every time, even when a specific goal was provided.
- **Ship gap:** Static-playbook-only path emits 1.1 KB of guidance identical across every session; there is no short/verbose mode.

## 2. `web-search`

- **Schema (key params):** `queries: string[]`, `extract: string`, plus internal flags like `raw` observed to exist.
- **Advertised behavior:** Tiered classification, signals, suggested follow-ups, consensus ranking.
- **Actually observed:**
  - 3 queries default mode: 12541 chars / ~3135 tokens / 28 URLs.
  - 1 query `raw: true` mode: 2704 chars / ~676 tokens / 6 URLs — density is near-identical to default because LLM is off, making `raw` and default indistinguishable in practice.
  - Every row is labelled `CONSENSUS`. Per-row header format:
    ```
    Score: X | Seen in: 1/3 queries (33%) | Best pos: #1 | Consistency: n/a
    ```
  - Metadata footer of each response contains:
    ```json
    "llm_classified":false,"llm_error":"Connection error."
    ```
- **Ship gap:** `CONSENSUS` label is noise when threshold is 1; `Consistency: n/a` on single-query hits is noise; the LLM classifier is attempted and failing but nothing surfaces to the agent besides that footer.

## 3. `search-reddit`

- **Schema (key params):** `queries: string[]`, `extract: string`.
- **Advertised behavior:** Reddit discovery for sentiment/migration signal.
- **Actually observed:** 3 queries → 2498 chars / 624 tokens / 28 URLs. Results include:
  - Subreddit homepages: `https://www.reddit.com/r/LLM_Gateways/` (with and without `/rising/`), `https://www.reddit.com/r/bun/rising/`.
  - Unrelated namesake hits for "Portkey" query: Harry Potter `/r/HarryPotterBooks/.../portkeys/`, `/r/videography/.../are_portkeys_worth_it_for_a_beginner/`.
- **Ship gap:** Leaks non-threads and out-of-topic namesakes; overlaps with `web-search + site:reddit.com`. Targeted for deletion per user directive.

## 4. `scrape-links`

- **Schema (key params):** `urls: string[]`, `extract: string`.
- **Advertised behavior:** Per-URL extraction with LLM cleanup, Markdown output.
- **Actually observed:** 1 URL (Merge blog) → 12704 chars / 3176 tokens. Header reports `Tokens/item: ~32,000`, `LLM extraction failures: 1`. The body contains:
  - Cookie banner text verbatim.
  - The "But Merge isn't just a Unified API product. Merge is an integration platform to also manage customer integrations. _gradient text_" block repeated **4×** verbatim.
  - Next Steps footer: `→ web-search(queries=[...], extract="verify scraped content") or search-reddit(queries=[...]) — cross-check claims`.
- **Ship gap:** No HTML chrome stripping server-side; "Next Steps" uses literal `[...]` placeholders that the agent cannot consume.

## 5. `get-reddit-post`

- **Schema (key params):** `urls: string[]` (Reddit post permalinks).
- **Advertised behavior:** Extract Reddit post + top comments as structured Markdown.
- **Actually observed:**
  - Good URL → 3020 chars. Banner at top: `⚠️ LLM unavailable (LLM_EXTRACTION_API_KEY not set) — raw content returned`. Next Steps: `→ web-search(queries=[...], extract="verify claims from Reddit") — cross-check Reddit findings` and `→ scrape-links(urls=[...URLs from comments...], extract="...") — scrape URLs referenced in comments`.
  - Bad URL (e.g. `https://example.com/not-reddit` or `https://reddit.com/r/nonexistent/comments/aaaaaa/fake/`) → body shows `Successful: 0 / Failed: 1` but `isError: None` (i.e. `false`). **MCP contract violation**: total failure must set `isError: true`.
  - For contrast, `scrape-links` with `not-a-url` correctly returns `isError: true` with an input-validation error. The `isError` bug is specific to `get-reddit-post` body-level failure, not input validation.
- **Ship gap:** `isError` contract violation on all-bad batches; Next Steps placeholders are non-actionable.

## Summary table

| Tool | Avg tokens per call | `isError` on body failure | Degrades when LLM off |
|---|---|---|---|
| `start-research` | ~1106 | n/a (no failure path probed) | Static playbook only, footer text emitted |
| `web-search` | ~1045/query (3135 for 3q) | n/a (no failure probed) | No classifier; `CONSENSUS` on every row; `"llm_classified":false`, `"llm_error":"Connection error."` |
| `search-reddit` | ~208/query (624 for 3q) | n/a | No filtering; subreddit homepages + namesakes leak through |
| `scrape-links` | ~3176 per URL | `true` on input-validation failure | Raw HTML + cookie banners + repeated hero blocks returned; credits still charged |
| `get-reddit-post` | ~3020 per URL | **`false` on all-bad URLs (bug)** | `⚠️ LLM unavailable` banner; raw content returned |

## Evidence

- Live probe transcripts captured 2026-04-18 against `mcp-researchpowerpack-http` v4.2.4. Saved to `/tmp/sr_brief.json`, `/tmp/ws_out.json`, `/tmp/ws_raw.json`, `/tmp/sc_out.json`, `/tmp/sr_reddit.json`, `/tmp/grp_out.json` (ephemeral).
- The contract-violation confirmation for `get-reddit-post` was cross-checked against `scrape-links` input-validation behavior to rule out a generic framework bug.
