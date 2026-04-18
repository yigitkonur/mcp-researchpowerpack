# Derailment Evidence

## Purpose

This file is the ground-truth friction log captured while a subagent ran a real user-energy task (LiteLLM alternatives research) through the `run-research` skill against the live server. Every proposed change in this plan must be checkable against one or more tags in this file. The tags are preserved verbatim from the trace so reviewers can search for them.

## How to read the tags

| Tag | Meaning |
|---|---|
| `[STEER-BAD]` | The tool pushed the agent in a direction the agent couldn't act on, or the tool silently dropped a contract the agent relied on. |
| `[FOOTER-BAD]` | The tool's closing "Next Steps" / footer block was non-actionable, placeholder-laced, or aimed at the operator instead of the agent. |
| `[FOOTER-GOOD]` | The tool's footer was specific, actionable, and advanced the research. |
| `[TOOL-NOISE]` | The tool shipped token-expensive noise (cookie banners, raw HTML, single-line JSON, always-on warnings) the agent had to work around. |
| `[REDUNDANT]` | Two tools overlap in scope and a consolidation is at least arguable. |
| `[NICE]` | A skill guardrail or decision-matrix item that materially helped the run. |
| `[GUESSED]` | The skill didn't address the situation the agent actually hit; the agent had to improvise. |

Read any proposed change through the lens of "which tag(s) does this retire?"

## Friction log (verbatim)

- `[STEER-BAD]` `start-research`: "Goal-tailored brief unavailable: LLM planner is not configured or failed this call." Agent provided a specific goal; got the generic playbook.
- `[FOOTER-BAD]` `start-research` closing line: "retry start-research after verifying LLM_API_KEY." — non-actionable for the agent (operator's job, not agent's).
- `[TOOL-NOISE]` `scrape-links` silently failed LLM extraction on all 15 URLs; got 253KB of raw HTML with GitHub nav chrome and JWT-signed image URLs. Still charged 15 credits.
- `[TOOL-NOISE]` `get-reddit-post` LLM-unavailable warning (always-on when key absent).
- `[TOOL-NOISE]` `web-search` `"llm_classified":false,"llm_error":"Connection error."` — LLM classifier **tried and failed**, not just unconfigured.
- `[TOOL-NOISE]` `web-search` first call was 135KB on a **single JSON line**. `Read` with `limit` errored because Read counts tokens for whole file before honoring `limit`. Had to drop to Python + json.load parsing.
- `[FOOTER-GOOD]` When `scrape-links` output was oversized, the error footer was excellent — explicit JSON schema, `jq` suggestion, Agent-tool delegation pattern.
- `[FOOTER-GOOD]` `get-reddit-post` "Next Steps" pointed to "verify claims from Reddit" and "scrape URLs referenced in comments" — accurate next move.
- `[REDUNDANT]` `scrape-links` and `get-reddit-post` could plausibly be one tool routed by URL. Counter-argument: Reddit's threaded comment tree is structurally different; separate extraction makes sense.
- `[NICE]` Skill's decision matrix ("Library comparison → Full loop: all 4 tools") routed the agent instantly.
- `[NICE]` Skill's guardrail "Never treat search snippets as evidence (they're leads — scrape to verify)" prevented quoting a "50x faster" marketing snippet.
- `[NICE]` "At least 25% negative signal" Reddit-branch guidance surfaced the LiteLLM March-2026 supply-chain attack and the Helicone acquisition.
- `[GUESSED]` Skill doesn't address what to do when the tool's LLM-augmentation layer is broken across 4 different tools simultaneously.
- `[GUESSED]` "Stop when additional tool calls stop changing your conclusion" is the only stop criterion. An explicit budget hint tied to time constraints would help.

## What the subagent still produced

Despite the friction above, the subagent produced a usable recommendation:

- **Primary pick:** Bifrost.
- **Backup:** Portkey.
- **Ruled out:** Helicone (acquired), Cloudflare AI Gateway (not a drop-in replacement for the LiteLLM use-case as scoped), OpenRouter (routing layer, not a gateway replacement).
- **Decisive evidence:** LiteLLM March-2026 supply-chain attack (surfaced via the Reddit branch) and the Helicone acquisition signal (also Reddit).

This matters for two reasons. First, it proves the **tools do work** — the LiteLLM-alternatives question got a defensible answer. Second, it means every gripe in the friction log is about **efficiency and contract**, not **capability**. A reviewer can use this as a sanity check when triaging a proposed change: if a change removes a feature the subagent used to form the recommendation, it needs a stronger justification than any of the friction tags alone.

## Evidence

- Live subagent run on 2026-04-18 against `mcp-researchpowerpack-http` v4.2.4, same session that produced the probe numbers in `02-current-tool-surface.md`.
- Friction log assembled in real time by the subagent as each tool call completed.
- Final recommendation summarized from the subagent's return message.
