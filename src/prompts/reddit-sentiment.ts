import { text, type MCPServer } from 'mcp-use/server';
import { z } from 'zod';

export function registerRedditSentimentPrompt(server: MCPServer): void {
  server.prompt(
    {
      name: 'reddit-sentiment',
      title: 'Reddit Sentiment',
      description: 'Research Reddit sentiment for a topic.',
      schema: z.object({
        topic: z.string().describe('Topic to evaluate.'),
        subreddits: z.string().optional().describe('Optional comma-separated subreddit filters.'),
      }),
    },
    async ({ topic, subreddits }) => {
      const subredditList = subreddits
        ? subreddits.split(',').map((value) => value.trim()).filter(Boolean)
        : [];

      return text(
        [
          'Use the research-powerpack MCP tools. Cite concrete Reddit comments when summarizing.',
          '',
          `Analyze Reddit sentiment for "${topic}"${subredditList.length ? ` in ${subredditList.join(', ')}` : ''}.`,
          '1. Call start-research first.',
          '2. Use search-reddit to discover relevant threads.',
          '3. Fetch the best threads with get-reddit-post.',
          '4. Summarize agreement, disagreement, and representative quotes.',
        ].join('\n'),
      );
    },
  );
}
