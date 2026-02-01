/**
 * MCP SDK Structured Logging Utility
 *
 * Sends log messages to MCP clients via server.sendLoggingMessage().
 * Falls back to stderr before the server is initialized.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

let serverRef: Server | null = null;

/**
 * Initialize the logger with an MCP server reference.
 * Must be called after server creation and before any tool execution.
 */
export function initLogger(server: Server): void {
  serverRef = server;
}

/**
 * Log message via MCP SDK structured logging.
 * Falls back to stderr if the server isn't initialized yet.
 * @param level - Log level
 * @param message - Message to log
 * @param tool - Tool/logger name for context
 */
export function mcpLog(level: LogLevel, message: string, tool?: string): void {
  const logger = tool ?? 'research-powerpack';
  if (serverRef) {
    serverRef.sendLoggingMessage({ level, data: message, logger }).catch(() => {});
  } else {
    // Fallback to stderr before MCP transport is connected
    console.error(`[${logger}] ${message}`);
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
