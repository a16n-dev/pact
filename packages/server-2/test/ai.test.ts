import { describe, it, expect, vi, afterEach } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../src/app';
import { api, ORIGIN, seedApp } from './helpers';
import { setAiProxy } from '../src/db/apps';

const GATEWAY_ENV = {
  ...env,
  CLOUDFLARE_ACCOUNT_ID: 'acct-1',
  AI_GATEWAY_ID: 'pact-gw',
  AI_GATEWAY_TOKEN: 'gw-secret',
};

function stubUpstream(respond: (req: Request) => Response): Request[] {
  const calls: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    return respond(req);
  });
  return calls;
}

async function proxy(
  token: string,
  path: string,
  init: RequestInit = {},
  bindings: typeof env = GATEWAY_ENV
) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AI Gateway proxy', () => {
  it('forwards the request to the configured gateway with the server credentials', async () => {
    const a = await seedApp('app-a');
    const calls = stubUpstream(
      () => new Response('{"id":"msg_1"}', { headers: { 'content-type': 'application/json' } })
    );
    const res = await proxy(a.token, '/ai/anthropic/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'leaked-provider-key',
        'cf-aig-skip-cache': 'true',
        origin: 'https://app.example.test',
      },
      body: '{"model":"claude-sonnet-4-5"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"msg_1"}');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.test');

    expect(calls).toHaveLength(1);
    const upstream = calls[0]!;
    expect(upstream.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-1/pact-gw/anthropic/v1/messages?beta=true'
    );
    expect(upstream.method).toBe('POST');
    expect(await upstream.text()).toBe('{"model":"claude-sonnet-4-5"}');
    expect(upstream.headers.get('cf-aig-authorization')).toBe('Bearer gw-secret');
    expect(JSON.parse(upstream.headers.get('cf-aig-metadata')!)).toEqual({
      app: 'app-a',
      token: a.tokenId,
    });
    expect(upstream.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(upstream.headers.get('content-type')).toBe('application/json');
    expect(upstream.headers.has('authorization')).toBe(false);
    expect(upstream.headers.has('x-api-key')).toBe(false);
    expect(upstream.headers.has('cf-aig-skip-cache')).toBe(false);
    expect(upstream.headers.has('origin')).toBe(false);
  });

  it('passes upstream 4xx responses through and keeps CORS headers its own', async () => {
    const a = await seedApp('app-a');
    stubUpstream(
      () =>
        new Response('{"error":"bad model"}', {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'cf-aig-cache-status': 'MISS',
            'access-control-allow-origin': '*',
            'set-cookie': 'x=1',
          },
        })
    );
    const res = await proxy(a.token, '/ai/openai/v1/chat/completions', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"error":"bad model"}');
    expect(res.headers.get('cf-aig-cache-status')).toBe('MISS');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('reports upstream failures as 502', async () => {
    const a = await seedApp('app-a');
    stubUpstream(() => new Response('oops', { status: 503 }));
    const failing = await proxy(a.token, '/ai/openai/v1/embeddings', { method: 'POST' });
    expect(failing.status).toBe(502);
    expect(await failing.json()).toEqual({
      error: 'AI Gateway returned 503',
      code: 'ai_upstream_error',
    });

    stubUpstream(() => {
      throw new Error('gateway down');
    });
    const down = await proxy(a.token, '/ai/openai/v1/embeddings', { method: 'POST' });
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: 'gateway down', code: 'ai_upstream_error' });
  });

  it('is 503 when the gateway is not configured', async () => {
    const a = await seedApp('app-a');
    const calls = stubUpstream(() => new Response());
    const res = await proxy(a.token, '/ai/openai/v1/models', {}, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'This server has no AI Gateway configured',
      code: 'ai_not_configured',
    });
    expect(calls).toHaveLength(0);
  });

  it('is 403 for an app with the AI proxy turned off', async () => {
    const a = await seedApp('app-a');
    await setAiProxy(env.DB, 'app-a', false);
    const calls = stubUpstream(() => new Response());
    const res = await proxy(a.token, '/ai/openai/v1/models');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'AI is turned off for this app',
      code: 'ai_disabled',
    });
    expect(calls).toHaveLength(0);
  });

  it('requires auth before touching the gateway', async () => {
    const calls = stubUpstream(() => new Response());
    const res = await proxy('pact_nope', '/ai/openai/v1/models');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('echoes requested headers for /ai preflights', async () => {
    const res = await api('/ai/anthropic/v1/messages', null, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-headers': 'anthropic-version, authorization',
      },
    });
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'anthropic-version, authorization'
    );
  });
});

describe('AI model runs', () => {
  function withAi(run: (...args: unknown[]) => Promise<Response>) {
    return { ...GATEWAY_ENV, AI: { run } as unknown as Ai };
  }

  it('runs the model through the gateway and passes the response through', async () => {
    const a = await seedApp('app-a');
    const calls: unknown[][] = [];
    const bindings = withAi(async (...args) => {
      calls.push(args);
      return new Response('{"result":{"image":"abc"}}', {
        headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' },
      });
    });
    const body = { prompt: 'an onion', size: '1024x1024' };
    const res = await proxy(
      a.token,
      '/ai/run/openai/gpt-image-1',
      { method: 'POST', body: JSON.stringify(body) },
      bindings
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"result":{"image":"abc"}}');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(calls).toEqual([
      [
        'openai/gpt-image-1',
        body,
        {
          gateway: { id: 'pact-gw', metadata: { app: 'app-a', token: a.tokenId } },
          returnRawResponse: true,
        },
      ],
    ]);
  });

  it('is 400 when the body is not a JSON object', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(async () => new Response());
    const res = await proxy(
      a.token,
      '/ai/run/typesafe/jev',
      { method: 'POST', body: '[]' },
      bindings
    );
    expect(res.status).toBe(400);
  });

  it('reports upstream failures as 502', async () => {
    const a = await seedApp('app-a');
    const failing = await proxy(
      a.token,
      '/ai/run/typesafe/jev',
      { method: 'POST', body: '{}' },
      withAi(async () => new Response('oops', { status: 500 }))
    );
    expect(failing.status).toBe(502);

    const down = await proxy(
      a.token,
      '/ai/run/typesafe/jev',
      { method: 'POST', body: '{}' },
      withAi(async () => {
        throw new Error('model down');
      })
    );
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: 'model down', code: 'ai_upstream_error' });
  });

  it('is 403 for an app with the AI proxy turned off', async () => {
    const a = await seedApp('app-a');
    await setAiProxy(env.DB, 'app-a', false);
    const calls: unknown[][] = [];
    const bindings = withAi(async (...args) => {
      calls.push(args);
      return new Response();
    });
    const res = await proxy(
      a.token,
      '/ai/run/typesafe/jev',
      { method: 'POST', body: '{}' },
      bindings
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
