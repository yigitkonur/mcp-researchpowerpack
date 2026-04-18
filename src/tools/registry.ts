import type { MCPServer } from 'mcp-use/server';

import { registerDeepResearchPrompt } from '../prompts/deep-research.js';
import { registerRedditSentimentPrompt } from '../prompts/reddit-sentiment.js';
import { registerGetRedditPostTool } from './reddit.js';
import { registerScrapeLinksTool } from './scrape.js';
import { registerWebSearchTool } from './search.js';
import { registerStartResearchTool } from './start-research.js';

export function registerAllTools(server: MCPServer): void {
  // Tool count is intentionally 4 — search-reddit was deleted in favor of
  // web-search with `scope: "reddit"`. See:
  //   docs/code-review/context/02-current-tool-surface.md
  //   mcp-revisions/tool-surface/01-delete-search-reddit.md
  //   mcp-revisions/tool-surface/02-extend-web-search-with-reddit-scope.md
  registerStartResearchTool(server);
  registerWebSearchTool(server);
  registerGetRedditPostTool(server);
  registerScrapeLinksTool(server);
  registerDeepResearchPrompt(server);
  registerRedditSentimentPrompt(server);
}
