import { text, type MCPServer } from 'mcp-use/server';
import { z } from 'zod';

export function registerDeepResearchPrompt(server: MCPServer): void {
  server.prompt(
    {
      name: 'deep-research',
      title: 'Deep Research',
      description: 'Start a multi-step research workflow on a topic.',
      schema: z.object({
        topic: z.string().describe('Topic to research.'),
      }),
    },
    async ({ topic }) => text(
      [
        'You are a research assistant. Use the research-powerpack MCP tools.',
        '',
        `Research "${topic}".`,
        '1. Call start-research first.',
        '2. Fan out diverse web-search queries.',
        '3. Inspect Signals and Suggested follow-up searches.',
        '4. Scrape the strongest URLs.',
        '5. Synthesize with citations.',
      ].join('\n'),
    ),
  );
}
