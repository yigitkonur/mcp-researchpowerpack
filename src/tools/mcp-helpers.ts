import { error, markdown, type TypedCallToolResult } from 'mcp-use/server';

type ClientLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

interface ReporterContext {
  log(level: ClientLogLevel, message: string, loggerName?: string): Promise<void>;
  reportProgress?: (loaded: number, total?: number, message?: string) => Promise<void>;
}

export interface ToolExecutionSuccess<T extends Record<string, unknown>> {
  readonly isError: false;
  readonly content: string;
  readonly structuredContent: T;
}

export interface ToolExecutionFailure {
  readonly isError: true;
  readonly content: string;
}

export type ToolExecutionResult<T extends Record<string, unknown>> =
  | ToolExecutionSuccess<T>
  | ToolExecutionFailure;

export interface ToolReporter {
  log(level: ClientLogLevel, message: string): Promise<void>;
  progress(loaded: number, total?: number, message?: string): Promise<void>;
}

export const NOOP_REPORTER: ToolReporter = {
  async log() {},
  async progress() {},
};

export function toolSuccess<T extends Record<string, unknown>>(
  content: string,
  structuredContent: T,
): ToolExecutionSuccess<T> {
  return {
    isError: false,
    content,
    structuredContent,
  };
}

export function toolFailure(content: string): ToolExecutionFailure {
  return {
    isError: true,
    content,
  };
}

export function createToolReporter(
  ctx: ReporterContext,
  loggerName: string,
): ToolReporter {
  return {
    log(level, message) {
      return ctx.log(level, message, loggerName);
    },
    progress(loaded, total, message) {
      return ctx.reportProgress?.(loaded, total, message) ?? Promise.resolve();
    },
  };
}

export function toToolResponse<T extends Record<string, unknown>>(
  result: ToolExecutionResult<T>,
): TypedCallToolResult<T> | TypedCallToolResult<never> {
  if (result.isError) {
    return error(result.content);
  }

  return {
    ...markdown(result.content),
    structuredContent: result.structuredContent,
  };
}
