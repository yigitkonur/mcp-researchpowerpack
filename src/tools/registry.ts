import type { MCPServer } from 'mcp-use/server';

import { registerDeepResearchPrompt } from '../prompts/deep-research.js';
import { registerRedditSentimentPrompt } from '../prompts/reddit-sentiment.js';
import { registerGetRedditPostTool, registerSearchRedditTool } from './reddit.js';
import { registerScrapeLinksTool } from './scrape.js';
import { registerWebSearchTool } from './search.js';
import { registerStartResearchTool } from './start-research.js';

export function registerAllTools(server: MCPServer): void {
  registerStartResearchTool(server);
  registerWebSearchTool(server);
  registerSearchRedditTool(server);
  registerGetRedditPostTool(server);
  registerScrapeLinksTool(server);
  registerDeepResearchPrompt(server);
  registerRedditSentimentPrompt(server);
}
