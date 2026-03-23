import type { MCPServer } from 'mcp-use/server';

import { registerGetRedditPostTool, registerSearchRedditTool } from './reddit.js';
import { registerDeepResearchTool } from './research.js';
import { registerScrapeLinksTool } from './scrape.js';
import { registerWebSearchTool } from './search.js';

export function registerAllTools(server: MCPServer): void {
  registerWebSearchTool(server);
  registerSearchRedditTool(server);
  registerGetRedditPostTool(server);
  registerScrapeLinksTool(server);
  registerDeepResearchTool(server);
}
