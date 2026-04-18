# AGENTS.md

Operating standard for AI agents working on this repository. Read first, every session.

## What this repo is

`mcp-researchpowerpack` (formerly `mcp-researchpowerpack-http` — HTTP suffix dropped in v4.3.0) — an HTTP-first MCP server built on `mcp-use` exposing 4 research tools: `web-search`, `scrape-links`, `get-reddit-post`, and `start-research` (bootstrap gate). ES-module TypeScript. Self-hosted — there is no canonical hosted instance. If you maintain your own deployment, set `MCP_DEPLOY_URL` in your local environment so the live-verification commands below resolve to your endpoint.

`CLAUDE.md` carries the full architecture map and command list. Read it for code-level work. `CHANGELOG.md` carries the user-facing release notes. This file is the **process** standard — what to do, in what order, with what verification.

## Branch + deploy contract

- Every push to `main` *should* trigger an auto-deploy to your linked Manufact server (set in `.mcp-use/project.json`), but the GitHub-webhook → Manufact path is not 100% reliable (it was observed silent during the v4.3.0 rename). After every push, verify the live `health://status.version` matches `package.json.version`. If not, run `pnpm dlx mcp-use deploy --org <your-org-slug> -y` to force a deploy.
- The "Publish to npm" GitHub Action is independent of Manufact and ships the package to https://www.npmjs.com/package/mcp-researchpowerpack — that's a separate success surface, do not conflate it with the live deploy being current.
- Long-running feature work happens on a branch in a worktree at `/Users/yigitkonur/dev/mcp-researchpowerpack-http-revisions/` (worktree path predates the repo rename — kept as-is).
- Never push to `main` without first running the verification chain in §"Before you push".
- Never push with `--no-verify`, `--force`, or `--no-gpg-sign` unless the user explicitly says so.
- `.mcp-use/project.json` is `.gitignore`d but the file gets rewritten by `mcp-use deploy`. If a deploy fails with "uncommitted changes", run `git update-index --skip-worktree .mcp-use/project.json` once and retry.

## Before you push

Run the full verification chain locally. All three must pass:

```bash
pnpm typecheck   # tsc --noEmit, strict mode
pnpm test:unit   # node:test across tests/*.test.ts
pnpm test:http   # spawns server on :3000 and exercises tools/list, prompts, resources, schemas
```

If any of these fail, fix before pushing. Pre-commit hooks exist for a reason — never bypass them.

## After you push — verify online with `test-by-mcpc-cli`

A local green test is necessary but not sufficient. The deploy could roll back, hit cold-start issues, or behave differently under the live LLM/Redis setup. **Always probe the live URL before claiming the work is done.**

The probe protocol uses the `test-by-mcpc-cli` skill. If the skill is not installed:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /test-by-mcpc-cli
```

Then invoke it as `/test-by-mcpc-cli` at the start of any verification session and follow its `0.2.x` session-first command family. The skill is the source of truth for `mcpc` syntax — do not improvise commands from older `0.1.x` examples.

### Standard live-server smoke test

Run this against your deployment URL after every deploy. Replace `$MCP_URL` with the URL Manufact (or your chosen platform) returned for the linked deployment:

```bash
mcpc connect "$MCP_URL" @rp
mcpc @rp ping
mcpc @rp tools-list --full | grep -E "name|requires"
mcpc @rp resources-read health://status
mcpc @rp close
```

Acceptance criteria for the current revision (v4.3+):

| Check | Expected |
|---|---|
| `tools-list` count | exactly 4 — `start-research`, `web-search`, `scrape-links`, `get-reddit-post`. **No `search-reddit`.** |
| `web-search` schema | exposes `scope: "web" \| "reddit" \| "both"` and `verbose: bool` |
| Gated tools precondition | `_meta.requires` lists `["start-research"]` on web-search, scrape-links, get-reddit-post (and not on start-research itself). `annotations.experimental.requires` is also set in code but mcp-use's wire-level annotation handling strips it; `_meta` is the actually-surviving channel. Probe with `mcpc --json @session tools-list` and check the `_meta` field. |
| `health://status` body | includes `llm_planner_ok`, `llm_extractor_ok`, `planner_configured`, `extractor_configured`, `workflow_state_size` |
| `initialize.capabilities` | includes `experimental.research_powerpack.{planner_available, extractor_available, requires_bootstrap}` |
| `start-research` body | starts with the `run-research` skill install hint (`npx -y skills add -y -g yigitkonur/skills-by-yigitkonur/skills/run-research`) |
| `start-research` (no `LLM_API_KEY` reachable) | emits the compact ~300-token degraded stub, not the full ~1100-token playbook |
| `start-research` with `include_playbook: true` | restores the full playbook |
| `scrape-links` with a Reddit URL | returns `isError: true` with `UNSUPPORTED_URL_TYPE` and points to `get-reddit-post` |
| `get-reddit-post` with all-bad URLs | returns `isError: true` (zero-success contract) |

If any acceptance criterion fails, the deploy is broken — investigate before moving on. Do not assume "the test was flaky."

## Companion skill — `run-research`

The MCP server is the toolbelt; the [`run-research` skill](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/run-research) is the discipline that teaches an agent how to spend the tools. Install it once per machine:

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur --skill /run-research
```

Or pull the full skills pack (~50 sibling skills):

```bash
npx -y skills add -y -g https://github.com/yigitkonur/skills-by-yigitkonur
```

The `start-research` tool emits this install hint on every session-boot — keep that hint in sync if you ever change the install command upstream.

## Agent operating loop

1. **Read** — `CLAUDE.md`, this file, the relevant `docs/code-review/context/*` doc for the area you are touching.
2. **Plan** — write a task list (max 30 tasks, one active at a time, every task ends with `commit changes`). Outcome-first names.
3. **Implement** — strict mode, kebab-case tool names, never throw from tool handlers, route failures through `toolFailure(...)` so `isError` flips correctly.
4. **Verify locally** — typecheck + unit + http per §"Before you push".
5. **Commit + push** — small, intentional commits. Push triggers deploy.
6. **Verify online** — `mcpc` probe per §"After you push".
7. **Stop** — only when every acceptance criterion is green on the live URL.

If the live verification surfaces a regression, fix it on a hot branch and ship the fix the same way. Never roll back the deploy without first exhausting forward-fix options.

## Don'ts

- Do not add new tools without explicit user direction. The contraction-and-quality directive from v4.3 still applies.
- Do not reintroduce `search-reddit`. Reddit discovery flows through `web-search` with `scope: "reddit"`.
- Do not pass Reddit URLs to `scrape-links`. The server rejects them with `UNSUPPORTED_URL_TYPE`.
- Do not add cookie-cutter "Next Steps" footers with literal `[...]` placeholders. Either emit concrete suggestions or omit the block.
- Do not promise `synthesis` / `gaps` / `refine_queries` from `start-research` when the planner is offline — `buildStaticScaffolding` already routes the loop step based on planner health.
- Do not assume in-memory state survives a deploy. The `InMemoryWorkflowStateStore` has a 24h TTL; Redis is the only durable store.

## Where to look first

| Need | File |
|---|---|
| Architecture map | `docs/code-review/context/01-server-architecture-map.md` |
| Current tool surface (with probe numbers) | `docs/code-review/context/02-current-tool-surface.md` |
| LLM degradation paths per function | `docs/code-review/context/03-llm-degradation-paths.md` |
| Session + workflow state lifecycle | `docs/code-review/context/04-session-and-workflow-state.md` |
| Output formatting patterns | `docs/code-review/context/05-output-formatting-patterns.md` |
| mcp-use best practices the server follows or doesn't | `docs/code-review/context/06-mcp-use-best-practices-primer.md` |
| Real subagent friction log driving every revision | `docs/code-review/context/07-derailment-evidence.md` |

## When you finish

Mention in your handoff that the next agent should:

1. Read this file (`AGENTS.md`) before touching code.
2. Use `/test-by-mcpc-cli` to verify any live-affecting change. Install if missing per §"After you push".
3. Always test on the live URL before claiming done — local-green is necessary but not sufficient.
4. Update this file when you change the deploy contract, add a new acceptance criterion, or evolve the skill install path.
