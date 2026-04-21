import type { MCPServer } from 'mcp-use/server';

import { registerDeepResearchPrompt } from '../prompts/deep-research.js';
import { registerRedditSentimentPrompt } from '../prompts/reddit-sentiment.js';
import { registerScrapeLinksTool } from './scrape.js';
import { registerWebSearchTool } from './search.js';
import { registerStartResearchTool } from './start-research.js';

export function registerAllTools(server: MCPServer): void {
  // 3 research tools. get-reddit-post was merged into scrape-links (auto-detects
  // reddit.com URLs). search-reddit was replaced by web-search with scope="reddit".
  registerStartResearchTool(server);
  registerWebSearchTool(server);
  registerScrapeLinksTool(server);
  registerDeepResearchPrompt(server);
  registerRedditSentimentPrompt(server);
}
