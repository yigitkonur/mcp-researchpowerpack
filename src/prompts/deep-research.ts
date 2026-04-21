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
        'You are a research agent using the research-powerpack MCP tools (3 tools: `start-research`, `web-search`, `scrape-links`). You are running a research LOOP, not answering from memory — every non-trivial claim in your final answer must be traceable to a `scrape-links` excerpt. Never cite a URL from a `web-search` snippet alone.',
        '',
        `Research goal: ${topic}`,
        '',
        '## Workflow',
        '',
        '1. **Call `start-research` with `goal` = the research goal above.** The server returns a goal-tailored brief: classified goal type, `primary_branch` (reddit / web / both), the exact `first_call_sequence`, 25–50 keyword seeds for your first `web-search` call, iteration hints, gaps to watch, and stop criteria.',
        '2. **Fire `first_call_sequence` in order.**',
        '   - `primary_branch: web` → one `web-search` (scope: "web") with all keyword seeds in a flat `queries` array, then one `scrape-links` on the HIGHLY_RELEVANT + 2–3 best MAYBE_RELEVANT URLs.',
        '   - `primary_branch: reddit` → one `web-search` (scope: "reddit") with the seeds, then one `scrape-links` on the best post permalinks (auto-detected → Reddit API threaded post + comments).',
        '   - `primary_branch: both` → two parallel `web-search` calls in one turn (scope: "web" + scope: "reddit"), then one merged `scrape-links`.',
        '   Set `extract` on `web-search` to a specific description of what "relevant" means for this goal (not just a keyword).',
        '3. **Read the classifier output**: `synthesis` (grounded in `[rank]` citations), `gaps` (each with an id), `refine_queries` (follow-ups linked to gap ids). If confidence is `low`, trust the `gaps` list more than the synthesis.',
        '4. **Read every scrape extract**. Each page returns `## Source`, `## Matches` (verbatim facts), `## Not found` (admitted gaps), `## Follow-up signals` (new terms + referenced-but-unscraped URLs). Harvest from `## Follow-up signals` — those terms seed your next `web-search` round.',
        '5. **Loop**: build the next `web-search` with the harvested terms + classifier-suggested refines. Scrape HIGHLY_RELEVANT URLs in contextually grouped parallel `scrape-links` calls (docs in one call, reddit threads in another). Stop when every `gaps_to_watch` item is closed AND no new terms appeared, OR after 4 passes — whichever comes first.',
        '',
        '## Output discipline',
        '',
        '- Cite URL (or Reddit permalink) for every non-trivial claim.',
        '- Quote verbatim: numbers, versions, API names, prices, error messages, stacktraces, people\'s words.',
        '- Separate documented facts from inferred conclusions explicitly.',
        '- Include scrape dates on time-sensitive claims.',
        '- If any `stop_criteria` item from the brief is unmet, say so — do not paper over it.',
      ].join('\n'),
    ),
  );
}
