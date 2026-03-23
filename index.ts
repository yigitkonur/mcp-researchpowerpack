#!/usr/bin/env node

import { Logger } from 'mcp-use';
import {
  InMemorySessionStore,
  InMemoryStreamManager,
  MCPServer,
  RedisSessionStore,
  RedisStreamManager,
  object,
  type ServerConfig,
} from 'mcp-use/server';
import { createClient, type RedisClientType } from 'redis';

import { SERVER } from './src/config/index.js';
import { registerAllTools } from './src/tools/registry.js';

const DEFAULT_PORT = 3000 as const;
const SHUTDOWN_TIMEOUT_MS = 10_000 as const;
const WEBSITE_URL = 'https://github.com/yigitkonur/mcp-researchpowerpack-http' as const;
const LOCAL_DEFAULT_HOST = '127.0.0.1' as const;

type CleanupFn = () => Promise<void>;

const startupLogger = Logger.get('startup');

function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : undefined;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function resolvePort(): number {
  const portFlagIndex = process.argv.findIndex((arg) => arg === '--port');
  if (portFlagIndex >= 0) {
    return parsePort(process.argv[portFlagIndex + 1], DEFAULT_PORT);
  }

  return parsePort(process.env.PORT, DEFAULT_PORT);
}

function resolveHost(): string {
  const explicitHost = process.env.HOST?.trim();
  if (explicitHost) {
    return explicitHost;
  }

  // Cloud runtimes typically inject PORT and expect the process to listen on all interfaces.
  if (process.env.PORT?.trim()) {
    return '0.0.0.0';
  }

  return LOCAL_DEFAULT_HOST;
}

function buildCors(allowedOrigins: string[] | undefined): ServerConfig['cors'] {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return undefined;
  }

  return {
    origin: allowedOrigins,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'mcp-protocol-version',
      'mcp-session-id',
      'X-Proxy-Token',
      'X-Target-URL',
    ],
    exposeHeaders: ['mcp-session-id'],
  };
}

function configureLogging(): void {
  Logger.configure({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: 'minimal',
  });

  const debug = process.env.DEBUG?.trim();
  if (debug === '2') {
    Logger.setDebug(2);
  } else if (debug) {
    Logger.setDebug(1);
  }
}

function normalizeOrigin(value: string, envName: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`${envName} must contain absolute URLs with protocol. Received: ${value}`);
  }
}

function resolveAllowedOrigins(): string[] | undefined {
  const explicitOrigins = parseCsvEnv(process.env.ALLOWED_ORIGINS);
  if (explicitOrigins && explicitOrigins.length > 0) {
    return explicitOrigins.map(origin => normalizeOrigin(origin, 'ALLOWED_ORIGINS'));
  }

  return undefined;
}

async function buildSessionConfig(): Promise<{
  sessionConfig: Pick<ServerConfig, 'sessionStore' | 'streamManager'>;
  cleanupFns: CleanupFn[];
}> {
  const redisUrl = process.env.REDIS_URL?.trim();

  if (!redisUrl) {
    return {
      sessionConfig: {
        sessionStore: new InMemorySessionStore(),
        streamManager: new InMemoryStreamManager(),
      },
      cleanupFns: [],
    };
  }

  const commandClient = createClient({ url: redisUrl });
  const pubSubClient = commandClient.duplicate();

  await Promise.all([commandClient.connect(), pubSubClient.connect()]);

  return {
    sessionConfig: {
      sessionStore: new RedisSessionStore({
        client: commandClient as RedisClientType,
      }),
      streamManager: new RedisStreamManager({
        client: commandClient as RedisClientType,
        pubSubClient: pubSubClient as RedisClientType,
      }),
    },
    cleanupFns: [
      async () => {
        await pubSubClient.quit();
      },
      async () => {
        await commandClient.quit();
      },
    ],
  };
}

function buildHealthPayload(server: MCPServer, startedAt: number) {
  return {
    status: 'ok',
    name: SERVER.NAME,
    version: SERVER.VERSION,
    transport: 'http',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    active_sessions: server.getActiveSessions().length,
    timestamp: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  configureLogging();

  const isProduction = process.env.NODE_ENV === 'production';
  const host = resolveHost();
  const port = resolvePort();
  const baseUrl = process.env.MCP_URL?.trim() || undefined;
  const allowedOrigins = resolveAllowedOrigins();

  const { sessionConfig, cleanupFns } = await buildSessionConfig();

  startupLogger.info(`Starting ${SERVER.NAME} v${SERVER.VERSION}`);
  startupLogger.info(`Binding HTTP server to ${host}:${port}`);
  if (allowedOrigins && allowedOrigins.length > 0) {
    startupLogger.info(`Host validation enabled for origins: ${allowedOrigins.join(', ')}`);
  } else if (isProduction) {
    startupLogger.warn(
      'Host validation is disabled because ALLOWED_ORIGINS is not set. ' +
      'Set ALLOWED_ORIGINS to the public deployment URL or custom domain after the first deploy.',
    );
  } else {
    startupLogger.info('Host validation disabled for local development');
  }

  const server = new MCPServer({
    name: SERVER.NAME,
    title: 'Research Powerpack',
    version: SERVER.VERSION,
    description: SERVER.DESCRIPTION,
    websiteUrl: WEBSITE_URL,
    host,
    baseUrl,
    cors: buildCors(allowedOrigins),
    allowedOrigins,
    ...sessionConfig,
  });

  registerAllTools(server);

  const startedAt = Date.now();

  server.get('/health', (c) => c.json(buildHealthPayload(server, startedAt)));
  server.get('/healthz', (c) => c.json(buildHealthPayload(server, startedAt)));
  server.resource(
    {
      name: 'server-health',
      uri: 'health://status',
      description: 'Current server health, uptime, and active MCP session count.',
      mimeType: 'application/json',
    },
    async () => object(buildHealthPayload(server, startedAt)),
  );

  let isShuttingDown = false;

  async function shutdown(signal: string, exitCode: number): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    const forceExit = setTimeout(() => {
      startupLogger.error(`Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms (${signal})`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      startupLogger.warn(`Shutdown signal received: ${signal}`);
      await server.close();

      for (const cleanupFn of cleanupFns) {
        await cleanupFn();
      }

      clearTimeout(forceExit);
      process.exit(exitCode);
    } catch (error) {
      clearTimeout(forceExit);
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      startupLogger.error(`Error while stopping server: ${message}`);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.on('uncaughtException', (error) => {
    startupLogger.error(`Uncaught exception: ${error.stack ?? error.message}`);
    void shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    startupLogger.error(`Unhandled rejection: ${String(reason)}`);
    void shutdown('unhandledRejection', 1);
  });

  await server.listen(port);

  startupLogger.info(`${SERVER.NAME} v${SERVER.VERSION} listening on http://${host}:${port}/mcp`);
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  startupLogger.error(`Server failed to start: ${message}`);
  process.exit(1);
});
