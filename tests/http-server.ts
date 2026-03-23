import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const TEST_PROTOCOL_VERSION = '2025-11-25' as const;
const TOOL_NAMES = [
  'web-search',
  'search-reddit',
  'get-reddit-post',
  'scrape-links',
  'deep-research',
] as const;

type ServerProcess = ReturnType<typeof spawn>;

function pnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function startServer(
  envOverrides: Record<string, string | undefined>,
): { child: ServerProcess; logs: { value: string } } {
  const child = spawn(pnpmCommand(), ['exec', 'tsx', 'index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_USE_ANONYMIZED_TELEMETRY: 'false',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = { value: '' };
  child.stdout.on('data', (chunk) => {
    logs.value += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs.value += chunk.toString();
  });

  return { child, logs };
}

async function stopServer(child: ServerProcess): Promise<void> {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    }),
    delay(5_000),
  ]);
}

async function waitForExit(
  child: ServerProcess,
  timeoutMs: number,
): Promise<number | null> {
  return Promise.race([
    new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    }),
    delay(timeoutMs).then(() => null),
  ]);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function requestWithHostHeader(
  baseUrl: string,
  path: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(path, baseUrl);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Host: hostHeader,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body,
          });
        });
      },
    );

    request.on('error', reject);
    request.end();
  });
}

async function postJsonRpc(
  baseUrl: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<Response> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  });

  if (sessionId) {
    headers.set('Mcp-Session-Id', sessionId);
    headers.set('MCP-Protocol-Version', TEST_PROTOCOL_VERSION);
  }

  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readJsonRpcBody(response: Response): Promise<any> {
  const raw = await response.text();

  try {
    return JSON.parse(raw);
  } catch {
    const events = raw.split('\n\n');

    for (const event of events) {
      const dataLines = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length === 0) {
        continue;
      }

      const payload = dataLines.join('\n');
      try {
        return JSON.parse(payload);
      } catch {
        // Try the next event block.
      }
    }

    throw new Error(`Unable to parse JSON-RPC response body: ${raw}`);
  }
}

async function assertProductionRequiresOriginProtection(): Promise<void> {
  const port = 3700 + Math.floor(Math.random() * 200);
  const { child, logs } = startServer({
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
  });

  try {
    const exitCode = await waitForExit(child, 10_000);
    assert.notEqual(exitCode, null, 'server should fail fast without ALLOWED_ORIGINS or MCP_URL');
    assert.notEqual(exitCode, 0, 'server should exit with a non-zero code');
    assert.match(logs.value, /ALLOWED_ORIGINS|MCP_URL/);
  } finally {
    if (child.exitCode === null) {
      await stopServer(child);
    }
  }
}

async function main(): Promise<void> {
  await assertProductionRequiresOriginProtection();

  const port = 3300 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, logs } = startServer({
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    ALLOWED_ORIGINS: baseUrl,
    SERPER_API_KEY: 'integration-test-key',
  });

  try {
    await waitForHealth(baseUrl, 20_000);

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.transport, 'http');

    const rejectedHost = await requestWithHostHeader(baseUrl, '/health', 'malicious.example.com');
    assert.ok(rejectedHost.status >= 400, 'expected invalid Host header to be rejected');

    const initializeResponse = await postJsonRpc(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: TEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'http-server-test',
          version: '1.0.0',
        },
      },
    });

    assert.equal(initializeResponse.status, 200);
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'expected mcp-session-id header');

    const initializeJson = await readJsonRpcBody(initializeResponse);
    assert.equal(initializeJson.jsonrpc, '2.0');
    assert.ok(initializeJson.result);

    await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      sessionId,
    );

    const toolsResponse = await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
      sessionId,
    );
    const toolsJson = await readJsonRpcBody(toolsResponse);
    const toolNames = toolsJson.result.tools.map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(toolNames, [...TOOL_NAMES].sort());
    assert.ok(
      toolsJson.result.tools.every((tool: { description?: unknown }) => (
        typeof tool.description === 'string' && tool.description.length > 0
      )),
      'expected every tool to expose a description',
    );

    const resourceResponse = await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: {
          uri: 'health://status',
        },
      },
      sessionId,
    );
    const resourceJson = await readJsonRpcBody(resourceResponse);
    assert.ok(resourceJson.result, 'expected resources/read result');
    assert.ok(JSON.stringify(resourceJson).includes('health://status'));

    const validationResponse = await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'web-search',
          arguments: {
            keywords: ['only-one-keyword'],
          },
        },
      },
      sessionId,
    );
    const validationJson = await readJsonRpcBody(validationResponse);
    const validationPayload = validationJson.error ?? validationJson.result;
    assert.ok(validationPayload, 'expected validation failure payload');
    const validationText = JSON.stringify(validationPayload).toLowerCase();
    assert.ok(
      validationText.includes('validation') || validationText.includes('keyword') || validationText.includes('3'),
    );

    const capabilityResponse = await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'scrape-links',
          arguments: {
            urls: ['https://example.com'],
          },
        },
      },
      sessionId,
    );
    const capabilityJson = await readJsonRpcBody(capabilityResponse);
    assert.ok(capabilityJson.result?.isError, 'expected tool-level error result');
    assert.ok(JSON.stringify(capabilityJson.result).includes('SCRAPEDO_API_KEY'));
  } catch (error) {
    throw new Error(`HTTP integration test failed.\n\nLogs:\n${logs.value}\n\n${String(error)}`);
  } finally {
    await stopServer(child);
  }
}

void main();
