import { text, type MCPServer } from 'mcp-use/server';
import { z } from 'zod';

export function registerRedditSentimentPrompt(server: MCPServer): void {
  server.prompt(
    {
      name: 'reddit-sentiment',
      title: 'Reddit Sentiment',
      description: 'Research Reddit sentiment for a topic using the research-powerpack tools — lived experience, migration stories, agreement/dissent distribution.',
      schema: z.object({
        topic: z.string().describe('Topic to evaluate. Phrase it as a sentiment question — "what developers actually think about X", "why teams moved from X to Y".'),
        subreddits: z.string().optional().describe('Optional comma-separated subreddit filters, e.g. "webdev,javascript".'),
      }),
    },
    async ({ topic, subreddits }) => {
      const subredditList = subreddits
        ? subreddits
            .split(',')
            .map((value) => value.trim().replace(/^\/?r\//i, ''))
            .filter(Boolean)
        : [];
      const subredditScope = subredditList.length
        ? ` Scope Reddit searches to ${subredditList.map((s) => `r/${s}`).join(', ')} when possible.`
        : '';

      return text(
        [
          'You are a research agent using the research-powerpack MCP tools (3 tools: `start-research`, `web-search`, `scrape-links`) to characterize Reddit sentiment. You are running a research LOOP, not answering from memory. Sentiment claims must be traceable to specific Reddit threads you expanded via `scrape-links` — never cite a thread you have not scraped.',
          '',
          `Research goal: Reddit sentiment on "${topic}" — agreement distribution, dissent distribution, representative verbatim quotes with attribution, and the strongest causal explanations.${subredditScope}`,
          '',
          '## Workflow',
          '',
          '1. **Call `start-research` with `goal` = the research goal above.** The brief will classify this as `sentiment`, set `primary_branch` to `reddit` (or `both` if official sources also matter), and list 25–50 seed queries ready for `web-search`.',
          '2. **Fire two parallel `web-search` calls in one turn** — one with `scope: "reddit"` for post-permalink discovery, one with `scope: "web"` for supporting evidence (post-mortems, blog write-ups, GitHub issues). Set `extract` to describe the shape of the sentiment answer: "agreement reasons | dissent reasons | representative quotes | migration drivers".',
          '3. **Shortlist the strongest Reddit threads** — those with (a) high comment count, (b) visible disagreement in replies, (c) specific stack/environment details from the OP. Avoid single-comment threads.',
          '4. **Fetch with `scrape-links`** — batch 3–10 reddit.com post permalinks in one call. `scrape-links` auto-detects `reddit.com/r/.../comments/` URLs and routes them through the Reddit API (threaded post + full comment tree). Read every comment tree end-to-end, not just the top-voted reply.',
          '5. **Scrape supporting evidence** with another `scrape-links` call (in parallel, different call from the reddit batch) — blog post-mortems, GitHub issues, HN discussions referenced in the threads. Use `extract` = "concrete reasons | stack details | version numbers | outcome". The extractor preserves verbatim quotes and surfaces referenced-but-unscraped URLs under `## Follow-up signals`.',
          '6. **Loop**: if the classifier flags gaps ("no dissent voices captured", "no migration timeline") or brief `gaps_to_watch` are unmet, build new queries and run another pass. Stop after 4 passes or when sentiment distribution stabilizes across two passes.',
          '',
          '## Output discipline',
          '',
          '- Report sentiment as a distribution ("~N of M replies agreed / ~K dissented / rest off-topic"), not a single mood label.',
          '- Cite every quote with the Reddit thread permalink plus `u/username` attribution.',
          '- Separate OP claims from reply-thread consensus — they often diverge.',
          '- If dissent is present, surface the strongest dissenting quote verbatim, even if the majority view dominates.',
          '- Include the scrape date on every time-sensitive claim.',
        ].join('\n'),
      );
    },
  );
}
