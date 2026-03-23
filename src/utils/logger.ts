/**
 * Server logging utility.
 *
 * This server is HTTP-only, so logging must never depend on a transport-bound
 * MCP server instance. All logs go to stderr to keep runtime behavior simple
 * and safe for hosted deployments.
 */

import { Logger } from 'mcp-use';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

function getLogger(name: string) {
  return Logger.get(name);
}

/**
 * SDK-backed logger with stable component names.
 * @param level - Log level
 * @param message - Message to log
 * @param loggerName - Tool/logger name for context
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

/**
 * Safe log that catches any errors (never crashes)
 * @param level - Log level
 * @param message - Message to log
 * @param tool - Tool name for context
 */
export function safeLog(level: LogLevel, message: string, tool?: string): void {
  try {
    mcpLog(level, message, tool);
  } catch {
    // Swallow logging errors - never crash
  }
}

/**
 * Create a bound logger for a specific tool
 */
export function createToolLogger(tool: string) {
  return {
    debug: (msg: string) => safeLog('debug', msg, tool),
    info: (msg: string) => safeLog('info', msg, tool),
    warning: (msg: string) => safeLog('warning', msg, tool),
    error: (msg: string) => safeLog('error', msg, tool),
  };
}

export type ToolLogger = ReturnType<typeof createToolLogger>;
