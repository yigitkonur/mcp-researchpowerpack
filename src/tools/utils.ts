/**
 * Shared tool utilities.
 *
 * Re-exports the logger and response formatters the tool handlers actually
 * use, plus centralized token budgets. Historical STDIO-era helpers
 * (ToolLogger/ToolOptions/safeLog/formatRetryHint/formatToolError/
 * validateNonEmptyArray/validateArrayBounds/buildBatchHeader/buildStatusLine)
 * were removed in v3.11.0 — the reporter pattern in `./mcp-helpers.ts`
 * replaces them.
 */

export { mcpLog, type LogLevel } from '../utils/logger.js';

export {
  formatSuccess,
  formatError,
  formatBatchHeader,
  formatDuration,
  type SuccessOptions,
  type ErrorOptions,
  type BatchHeaderOptions,
} from '../utils/response.js';

/**
 * Centralized token budgets for all tools
 */
export const TOKEN_BUDGETS = {
  /** Deep research total budget */
  RESEARCH: 32_000,
  /** Web scraper total budget */
  SCRAPER: 32_000,
  /** Reddit comment budget per batch */
  REDDIT_COMMENTS: 1_000,
} as const;

/**
 * Calculate token allocation for batch operations.
 * Distributes a fixed budget across multiple items.
 */
export function calculateTokenAllocation(count: number, budget: number): number {
  if (count <= 0) return budget;
  return Math.floor(budget / count);
}
