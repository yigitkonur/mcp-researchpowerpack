import { text, type MCPServer } from 'mcp-use/server';
import { z } from 'zod';

export function registerDeepResearchPrompt(server: MCPServer): void {
  server.prompt(
    {
      name: 'deep-research',
      title: 'Deep Research',
      description: 'Multi-pass research loop on a topic using the research-powerpack tools.',
      schema: z.object({
        topic: z.string().describe('Topic to research. Be specific about what "done" looks like — the first tool call will generate a goal-tailored research brief from it.'),
      }),
    },
    async ({ topic }) => text(
      [
        'You are a research agent using the research-powerpack MCP tools. You are running a research LOOP, not answering from memory — every claim in your final answer must be traceable to a scraped page or expanded Reddit thread. Never cite a URL from a search snippet alone.',
        '',
        `Research goal: ${topic}`,
        '',
        '## Workflow',
        '',
        '1. **Call `start-research` with `goal` = the research goal above.** The server returns a goal-tailored brief: classified goal type, source priorities, a Reddit-branch recommendation, anticipated gaps, 3–8 pre-built concept groups (25–50 concrete queries ready to fire), first-pass scrape targets, and success criteria. Read it carefully — it tells you exactly what pass 1 should look like.',
        '2. **Fire ONE `web-search` call** with every query from every concept group concatenated into the flat `queries` array. Set `extract` to a specific description of what "relevant" means for this goal (not just a keyword).',
        '3. **Read the classifier output**: `synthesis` (grounded in `[rank]` citations), `gaps` (what is missing — each with an id), `refine_queries` (follow-ups linked to gap ids). If confidence is `low`, trust the `gaps` list more than the synthesis.',
        '4. **Scrape with `scrape-links`** — every HIGHLY_RELEVANT plus the 2–3 best MAYBE_RELEVANT, batched in one call. Write `extract` as facets separated by `|` (e.g. `root cause | affected versions | fix | workarounds`). Each page returns a structured extract with `## Matches`, `## Not found` (admitted gaps), and `## Follow-up signals` (new terms + referenced-but-unscraped URLs that should seed the next search pass).',
        '5. **Reddit branch** — only if the brief says `fire_reddit_branch: true`. Call `web-search` again with `scope: "reddit"` for post-permalink discovery, then `get-reddit-post` on the 3–10 strongest threads. Never cite a Reddit thread you have not expanded.',
        '6. **Loop**: build new concept groups for the unclosed gaps, fire another `web-search`, scrape, read. Stop when every gap is closed AND no new terms appear, OR after 4 passes — whichever comes first.',
        '',
        '## Output discipline',
        '',
        '- Cite URL (or Reddit thread permalink) for every non-trivial claim.',
        '- Separate documented facts from inferred conclusions explicitly.',
        '- Include scrape dates for time-sensitive claims.',
        '- If any success criterion from the brief is unmet, say so — do not paper over it.',
      ].join('\n'),
    ),
  );
}
