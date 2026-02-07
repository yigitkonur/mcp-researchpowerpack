/**
 * Cloudflare Workers entry point for Research Powerpack MCP
 * Uses the `agents` package McpAgent pattern for Durable Object-backed MCP sessions.
 *
 * NOTE: This file deliberately avoids importing from `tools/definitions.ts` because
 * that module loads YAML from disk via `config/loader.ts` (readFileSync + import.meta.url),
 * which is incompatible with the Workers runtime. Instead, tools are registered directly
 * from `toolRegistry` which carries Zod schemas and handlers without filesystem access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';

import { toolRegistry, executeTool } from './tools/registry.js';
import { getCapabilities, SERVER } from './config/index.js';

// Short descriptions for each tool (avoids pulling from YAML at runtime)
const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_reddit:
    'Search Reddit with 10-50 diverse parallel queries. Each query targets a different angle.',
  get_reddit_post:
    'Fetch Reddit posts and comments. Supports AI extraction via use_llm flag.',
  deep_research:
    'Deep research with 2-10 parallel questions and 32K token budget.',
  scrape_links:
    'Scrape 1-50 URLs with optional AI content extraction.',
  web_search:
    'Parallel Google search with 3-100 keywords returning 10 results each.',
};

export class ResearchPowerpackMCP extends McpAgent {
  server = new McpServer({
    name: SERVER.NAME,
    version: SERVER.VERSION,
  });

  async init() {
    const capabilities = getCapabilities();

    for (const [name, tool] of Object.entries(toolRegistry)) {
      const description = TOOL_DESCRIPTIONS[name] ?? name;
      // Extract the raw Zod shape from the ZodObject for McpServer.tool()
      const shape = (tool.schema as any).shape ?? {};

      this.server.tool(
        name,
        description,
        shape,
        async (args: Record<string, unknown>) => {
          try {
            return await executeTool(name, args, capabilities);
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      );
    }
  }
}

export default {
  fetch(request: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', name: SERVER.NAME, version: SERVER.VERSION }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/message') {
      return ResearchPowerpackMCP.serve('/mcp').fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
};
