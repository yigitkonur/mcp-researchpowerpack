import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const TEST_PROTOCOL_VERSION = '2025-11-25' as const;
const TOOL_NAMES = [
  'start-research',
  'web-search',
  'scrape-links',
] as const;

const PROVIDER_ENV_KEYS = [
  'SERPER_API_KEY',
  'SCRAPEDO_API_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'JINA_API_KEY',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_FALLBACK_MODEL',
] as const;

type ServerProcess = ReturnType<typeof spawn>;

function pnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function startServer(
  envOverrides: Record<string, string | undefined>,
): { child: ServerProcess; logs: { value: string } } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_USE_ANONYMIZED_TELEMETRY: 'false',
  };

  for (const key of PROVIDER_ENV_KEYS) {
    delete env[key];
  }

  Object.assign(env, envOverrides);

  const child = spawn(pnpmCommand(), ['exec', 'tsx', 'index.ts'], {
    cwd: process.cwd(),
    env,
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

function isJsonRpcNotification(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'method' in payload &&
    !('id' in payload) &&
    !('result' in payload) &&
    !('error' in payload)
  );
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
        const parsed = JSON.parse(payload);
        if (isJsonRpcNotification(parsed)) {
          continue;
        }
        return parsed;
      } catch {
        // Try the next event block.
      }
    }

    throw new Error(`Unable to parse JSON-RPC response body: ${raw}`);
  }
}

async function callTool(
  baseUrl: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<any> {
  const response = await postJsonRpc(
    baseUrl,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    sessionId,
  );
  return readJsonRpcBody(response);
}

function assertToolInputRejected(json: any, label: string): void {
  const isJsonRpcError = json.error !== undefined;
  const isToolError = json.result?.isError === true;
  assert.ok(
    isJsonRpcError || isToolError,
    `${label}: expected validation failure, got success. Payload: ${JSON.stringify(json)}`,
  );
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

async function assertPartialLlmEnvDegrades(): Promise<void> {
  const port = 3900 + Math.floor(Math.random() * 200);
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, logs } = startServer({
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    ALLOWED_ORIGINS: baseUrl,
    LLM_API_KEY: 'partial-test-key',
  });

  try {
    await waitForHealth(baseUrl, 20_000);

    const healthFields = await fetch(`${baseUrl}/health`).then((r) => r.json());
    assert.equal(healthFields.planner_configured, false);
    assert.equal(healthFields.extractor_configured, false);

    const initializeResponse = await postJsonRpc(baseUrl, {
      jsonrpc: '2.0',
      id: 101,
      method: 'initialize',
      params: {
        protocolVersion: TEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'partial-llm-env-test',
          version: '1.0.0',
        },
      },
    });

    assert.equal(initializeResponse.status, 200);
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'expected mcp-session-id header for partial LLM env');
    const initializeJson = await readJsonRpcBody(initializeResponse);
    assert.ok(initializeJson.result, 'expected initialize result for partial LLM env');

    await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      sessionId,
    );

    const startedJson = await callTool(
      baseUrl,
      sessionId,
      'start-research',
      { goal: 'partial LLM environment smoke test' },
      102,
    );
    assert.notEqual(startedJson.result?.isError, true);
    const startedText: string | undefined = startedJson.result?.content?.[0]?.text;
    assert.equal(typeof startedText, 'string');
    assert.match(startedText!, /LLM planner offline|compact stub/);
    assert.doesNotMatch(JSON.stringify(startedJson), /LLM_BASE_URL is required/);
  } finally {
    if (child.exitCode === null) {
      await stopServer(child);
    }
  }

  assert.doesNotMatch(logs.value, /LLM_BASE_URL is required/);
  assert.doesNotMatch(logs.value, /LLM_MODEL is required/);
}

async function main(): Promise<void> {
  await assertProductionRequiresOriginProtection();
  await assertPartialLlmEnvDegrades();

  const port = 3300 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, logs } = startServer({
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    ALLOWED_ORIGINS: baseUrl,
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
    assert.ok(Array.isArray(toolsJson.result?.tools), 'expected tools/list tools array');
    const tools = toolsJson.result.tools as Array<{
      name: string;
      title?: string;
      description?: unknown;
      annotations?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      inputSchema?: {
        required?: unknown;
      } & Record<string, unknown>;
    }>; // checked: tools/list returned an array; field-specific assertions follow.
    const toolNames = tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [...TOOL_NAMES].sort());
    assert.ok(
      tools.every((tool) => (
        typeof tool.description === 'string' && tool.description.length > 0
      )),
      'expected every tool to expose a description',
    );
    const scrapeLinksTool = tools.find((tool) => tool.name === 'scrape-links');
    assert.ok(scrapeLinksTool?.inputSchema, 'expected scrape-links inputSchema');
    const scrapeLinksRequired = scrapeLinksTool.inputSchema.required;
    assert.ok(Array.isArray(scrapeLinksRequired), 'expected scrape-links inputSchema.required array');
    assert.ok(scrapeLinksRequired.includes('urls'), 'expected scrape-links to require urls');
    assert.equal(
      scrapeLinksRequired.includes('extract'),
      false,
      'scrape-links extract must be optional for raw mode',
    );

    const promptsJson = await readJsonRpcBody(await postJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 25,
        method: 'prompts/list',
      },
      sessionId,
    ));
    const promptNames = promptsJson.result.prompts.map((prompt: { name: string }) => prompt.name).sort();
    assert.deepEqual(promptNames, []);

    // --- Compliance: annotations + outputSchema ---
    const expectedAnnotationKeys = [
      'readOnlyHint',
      'idempotentHint',
      'destructiveHint',
      'openWorldHint',
    ] as const;

    for (const tool of tools) {
      assert.ok(
        typeof tool.title === 'string' && tool.title.length > 0,
        `${tool.name}: expected a non-empty title`,
      );
      assert.ok(tool.annotations, `${tool.name}: expected annotations object`);
      for (const key of expectedAnnotationKeys) {
        assert.ok(
          key in (tool.annotations ?? {}),
          `${tool.name}: missing annotation "${key}"`,
        );
      }
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `${tool.name}: expected readOnlyHint=true`,
      );
      assert.equal(
        tool.annotations?.openWorldHint,
        tool.name === 'start-research' ? false : true,
        `${tool.name}: unexpected openWorldHint`,
      );
      // inputSchema is required by the MCP spec
      assert.ok(
        tool.inputSchema && typeof tool.inputSchema === 'object',
        `${tool.name}: expected a declared inputSchema`,
      );
      if (tool.outputSchema) {
        assert.equal(
          typeof tool.outputSchema,
          'object',
          `${tool.name}: outputSchema should be an object if present`,
        );
      }
    }

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

    // contract-fixes/02: health://status surfaces LLM augmentation health so
    // capability-aware clients can branch at session start instead of parsing
    // per-call footers.
    const resourceText = JSON.stringify(resourceJson);
    for (const field of [
      'llm_planner_ok',
      'llm_extractor_ok',
      'planner_configured',
      'extractor_configured',
      'consecutive_planner_failures',
      'consecutive_extractor_failures',
    ]) {
      assert.ok(resourceText.includes(field), `expected health://status to include "${field}"`);
    }

    // /health HTTP endpoint surfaces the same fields for load-balancer probes.
    const healthFields = await fetch(`${baseUrl}/health`).then((r) => r.json());
    // *_ok is `boolean | null` — null means "never probed" (initial state);
    // `false` means "probed and the last attempt failed".
    const isBoolOrNull = (v: unknown): boolean => typeof v === 'boolean' || v === null;
    assert.ok(isBoolOrNull(healthFields.llm_planner_ok), 'llm_planner_ok must be boolean|null');
    assert.ok(isBoolOrNull(healthFields.llm_extractor_ok), 'llm_extractor_ok must be boolean|null');
    assert.equal(typeof healthFields.planner_configured, 'boolean');
    assert.equal(typeof healthFields.extractor_configured, 'boolean');
    // Counters must be non-negative integers; they back the gate in start-research.
    assert.ok(
      Number.isInteger(healthFields.consecutive_planner_failures) &&
        healthFields.consecutive_planner_failures >= 0,
      'consecutive_planner_failures must be a non-negative integer',
    );
    assert.ok(
      Number.isInteger(healthFields.consecutive_extractor_failures) &&
        healthFields.consecutive_extractor_failures >= 0,
      'consecutive_extractor_failures must be a non-negative integer',
    );

    // contract-fixes/02: experimental.research_powerpack capability advertised
    // on initialize so capability-aware clients see it without calling tools.
    const initText = JSON.stringify(initializeJson);
    assert.ok(
      initText.includes('research_powerpack'),
      'expected initialize.capabilities.experimental.research_powerpack',
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
            extract: 'Extract main content',
          },
        },
      },
      sessionId,
    );
    const capabilityJson = await readJsonRpcBody(capabilityResponse);
    assert.ok(capabilityJson.result?.isError, 'expected tool-level error result');
    assert.ok(JSON.stringify(capabilityJson.result).includes('SCRAPEDO_API_KEY'));

    // Default mode (no LLM_API_KEY in test env) → degraded compact stub.
    const startedJson = await callTool(baseUrl, sessionId, 'start-research', {}, 7);
    assert.notEqual(startedJson.result?.isError, true);
    // start-research carries no structuredContent (dedup v6.1): primary markdown
    // lives in content[0].text, nothing structured to expose.
    const startedText: string | undefined = startedJson.result?.content?.[0]?.text;
    assert.equal(typeof startedText, 'string');
    assert.equal(startedJson.result?.structuredContent, undefined, 'start-research must not emit structuredContent');
    assert.match(startedText!, /Research session started/);
    assert.match(startedText!, /scrape-links/);
    assert.match(startedText!, /web-search/);
    // Degraded stub explicitly mentions the planner-offline state.
    assert.match(startedText!, /LLM planner offline|compact stub/);
    // Stub should be dramatically smaller than the full playbook — size-bound
    // against the primary markdown now that structuredContent is gone.
    const stubBytes = (startedText ?? '').length;
    assert.ok(stubBytes < 2500, `expected degraded stub <2500 bytes, got ${stubBytes}`);

    // Opting into the full playbook via include_playbook=true restores the full tactic reference.
    const playbookJson = await callTool(
      baseUrl,
      sessionId,
      'start-research',
      { include_playbook: true },
      71,
    );
    assert.notEqual(playbookJson.result?.isError, true);
    assert.match(JSON.stringify(playbookJson.result), /The 3 tools/);
    assert.match(JSON.stringify(playbookJson.result), /The loop/);
    assert.match(JSON.stringify(playbookJson.result), /Output discipline/);
    assert.match(JSON.stringify(playbookJson.result), /parallel|Parallel/);

    // --- Schema rejection tests ---
    // web-search: requires queries + extract
    assertToolInputRejected(
      await callTool(baseUrl, sessionId, 'web-search', { queries: [], extract: 'test goal' }, 10),
      'web-search empty queries',
    );
    assertToolInputRejected(
      await callTool(baseUrl, sessionId, 'web-search', { queries: ['test'] }, 10),
      'web-search missing extract',
    );

    // scrape-links: requires urls; extract is optional for v6 raw mode.
    assertToolInputRejected(
      await callTool(baseUrl, sessionId, 'scrape-links', { urls: [], extract: 'test data' }, 13),
      'scrape-links empty URLs',
    );
    const rawScrapeWithoutExtract = await callTool(
      baseUrl,
      sessionId,
      'scrape-links',
      { urls: ['https://example.com'] },
      13,
    );
    assert.ok(rawScrapeWithoutExtract.result?.isError, 'expected provider-free raw scrape to fail');
    assert.ok(
      JSON.stringify(rawScrapeWithoutExtract.result).includes('SCRAPEDO_API_KEY'),
      'expected raw scrape without extract to fail for missing scraping capability, not schema validation',
    );

    // scrape-links: rejects non-http protocols
    assertToolInputRejected(
      await callTool(
        baseUrl,
        sessionId,
        'scrape-links',
        { urls: ['ftp://example.com/file.txt'], extract: 'test data' },
        14,
      ),
      'scrape-links rejects ftp scheme',
    );
  } catch (error) {
    throw new Error(`HTTP integration test failed.\n\nLogs:\n${logs.value}\n\n${String(error)}`);
  } finally {
    await stopServer(child);
  }
}

void main();
