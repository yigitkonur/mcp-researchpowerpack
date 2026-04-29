import assert from 'node:assert/strict';
import test from 'node:test';

import { JinaClient } from '../src/clients/jina.js';
import { ErrorCode } from '../src/utils/errors.js';

type FetchArgs = Parameters<typeof fetch>;
type RecordedCall = { url: string; init: RequestInit | undefined };
type FakeResponse = { status: number; body: string; headers?: Record<string, string> };

function installFakeFetch(responses: FakeResponse[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    calls.push({ url: String(input), init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  test.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test('JinaClient: 200 success returns content', async () => {
  const calls = installFakeFetch([
    { status: 200, body: '# Hello world\n\nSome markdown from a PDF.', headers: { 'x-usage-tokens': '1234' } },
  ]);
  const client = new JinaClient();
  const result = await client.convert({ url: 'https://example.com/foo.pdf' });

  assert.equal(result.statusCode, 200);
  assert.equal(result.error, undefined);
  assert.match(result.content, /Hello world/);
  assert.equal(result.usageTokens, 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://r.jina.ai/https://example.com/foo.pdf');
});

test('JinaClient: Authorization header set when JINA_API_KEY configured', async () => {
  const calls = installFakeFetch([
    { status: 200, body: 'ok' },
  ]);
  const client = new JinaClient('test-key-abc');
  await client.convert({ url: 'https://example.com/foo.pdf' });

  const headers = new Headers(calls[0]!.init?.headers as HeadersInit);
  assert.equal(headers.get('authorization'), 'Bearer test-key-abc');
});

test('JinaClient: no Authorization header when key absent', async () => {
  const calls = installFakeFetch([
    { status: 200, body: 'ok' },
  ]);
  // Construct without a key and ensure no env key leaks in.
  const prevEnv = process.env.JINA_API_KEY;
  delete process.env.JINA_API_KEY;
  try {
    const client = new JinaClient();
    await client.convert({ url: 'https://example.com/foo.pdf' });
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit);
    assert.equal(headers.get('authorization'), null);
  } finally {
    if (prevEnv !== undefined) process.env.JINA_API_KEY = prevEnv;
  }
});

test('JinaClient: 401 returns AUTH_ERROR without retry', async () => {
  const calls = installFakeFetch([
    { status: 401, body: 'unauthorized' },
  ]);
  const client = new JinaClient('bad-key');
  const result = await client.convert({ url: 'https://example.com/x.pdf' });

  assert.equal(result.statusCode, 401);
  assert.equal(result.error?.code, ErrorCode.AUTH_ERROR);
  assert.equal(result.error?.retryable, false);
  assert.equal(calls.length, 1); // no retry
});

test('JinaClient: 404 returns NOT_FOUND', async () => {
  const calls = installFakeFetch([
    { status: 404, body: 'not found' },
  ]);
  const client = new JinaClient();
  const result = await client.convert({ url: 'https://example.com/missing.pdf' });

  assert.equal(result.statusCode, 404);
  assert.equal(result.error?.code, ErrorCode.NOT_FOUND);
  assert.equal(calls.length, 1);
});

test('JinaClient: invalid URL returns INVALID_INPUT without fetching', async () => {
  const calls = installFakeFetch([]);
  const client = new JinaClient();
  const result = await client.convert({ url: 'not-a-url' });

  assert.equal(result.statusCode, 400);
  assert.equal(result.error?.code, ErrorCode.INVALID_INPUT);
  assert.equal(calls.length, 0);
});

test('JinaClient: empty body surfaces UNSUPPORTED_BINARY_CONTENT', async () => {
  installFakeFetch([
    { status: 200, body: '   \n\n  ' },
  ]);
  const client = new JinaClient();
  const result = await client.convert({ url: 'https://example.com/empty.pdf' });

  assert.equal(result.error?.code, ErrorCode.UNSUPPORTED_BINARY_CONTENT);
});
