/**
 * Server logging utility.
 *
 * This server is HTTP-only, so logging must never depend on a transport-bound
 * MCP server instance. All logs flow through mcp-use's Logger, which writes to
 * stderr in Node and console in the browser.
 */

import { Logger } from 'mcp-use';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

function getLogger(name: string) {
  return Logger.get(name);
}

/**
 * Structured log helper backed by mcp-use's Logger.
 *
 * @param level - Log level.
 * @param message - Message to emit.
 * @param loggerName - Tool/component name for context (falls back to "research-powerpack").
 */
export function mcpLog(level: LogLevel, message: string, loggerName?: string): void {
  const logger = getLogger(loggerName ?? 'research-powerpack');

  switch (level) {
    case 'debug':
      logger.debug(message);
      break;
    case 'info':
      logger.info(message);
      break;
    case 'warning':
      logger.warn(message);
      break;
    case 'error':
      logger.error(message);
      break;
  }
}
