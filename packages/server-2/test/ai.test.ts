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

function withAi(run: (...args: unknown[]) => Promise<Response>) {
  return { ...GATEWAY_ENV, AI: { run } as unknown as Ai };
}

function post(path: string, body: unknown): RequestInit & { path: string } {
  return { path, method: 'POST', body: JSON.stringify(body) };
}

async function call(token: string, request: RequestInit & { path: string }, bindings: typeof env) {
  const { path, ...init } = request;
  return proxy(token, path, init, bindings);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AI images', () => {
  it('runs the model through the gateway with the mapped options', async () => {
    const a = await seedApp('app-a');
    const calls: unknown[][] = [];
    const bindings = withAi(async (...args) => {
      calls.push(args);
      return json({ result: { image: base64(PNG) } });
    });
    const res = await call(
      a.token,
      post('/ai/images', {
        model: 'openai/gpt-image-1',
        prompt: 'an onion',
        size: '1024x1024',
        background: 'transparent',
      }),
      bindings
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      [
        'openai/gpt-image-1',
        { prompt: 'an onion', size: '1024x1024', background: 'transparent' },
        {
          gateway: { id: 'pact-gw', metadata: { app: 'app-a', token: a.tokenId } },
          returnRawResponse: true,
        },
      ],
    ]);
  });

  it('returns the bytes when the model answers with base64', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(async () => json({ image: `data:image/png;base64,${base64(PNG)}` }));
    const res = await call(a.token, post('/ai/images', { model: 'm/x', prompt: 'p' }), bindings);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('fetches the image when the model answers with a link', async () => {
    const a = await seedApp('app-a');
    const calls = stubUpstream(() => new Response(PNG));
    const bindings = withAi(async () =>
      json({ result: { image: 'https://ai-gateway-outputs.example/out/1' } })
    );
    const res = await call(a.token, post('/ai/images', { model: 'm/x', prompt: 'p' }), bindings);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(calls.map((req) => req.url)).toEqual(['https://ai-gateway-outputs.example/out/1']);
  });

  it('passes raw image responses through', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(
      async () => new Response(PNG, { headers: { 'content-type': 'image/png' } })
    );
    const res = await call(a.token, post('/ai/images', { model: 'm/x', prompt: 'p' }), bindings);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('converts the image when the request asks for an output', async () => {
    const a = await seedApp('app-a');
    const transforms: unknown[] = [];
    const outputs: unknown[] = [];
    const inputs: Uint8Array[] = [];
    const images = {
      input(stream: ReadableStream<Uint8Array>) {
        const read = new Response(stream).arrayBuffer().then((buffer) => {
          inputs.push(new Uint8Array(buffer));
        });
        const transformer = {
          transform(options: unknown) {
            transforms.push(options);
            return transformer;
          },
          async output(options: unknown) {
            await read;
            outputs.push(options);
            return {
              image: () => new Response('webp-bytes').body!,
              contentType: () => 'image/webp',
            };
          },
        };
        return transformer;
      },
    };
    const bindings = {
      ...withAi(async () => json({ image: base64(PNG) })),
      IMAGES: images as unknown as ImagesBinding,
    };
    const res = await call(
      a.token,
      post('/ai/images', {
        model: 'm/x',
        prompt: 'p',
        output: { width: 256, height: 256, format: 'webp', quality: 85 },
      }),
      bindings
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(await res.text()).toBe('webp-bytes');
    expect(inputs).toEqual([PNG]);
    expect(transforms).toEqual([{ width: 256, height: 256, fit: 'contain' }]);
    expect(outputs).toEqual([{ format: 'image/webp', quality: 85 }]);
  });

  it('is 400 for an output it cannot produce, before running the model', async () => {
    const a = await seedApp('app-a');
    const calls: unknown[][] = [];
    const bindings = withAi(async (...args) => {
      calls.push(args);
      return new Response();
    });
    for (const output of [
      { format: 'bmp' },
      { format: 'webp', width: 4096 },
      { format: 'webp', width: 25.5 },
      { format: 'webp', fit: 'stretch' },
      { format: 'webp', quality: 0 },
    ]) {
      const res = await call(
        a.token,
        post('/ai/images', { model: 'm/x', prompt: 'p', output }),
        bindings
      );
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('reports a failed conversion as 502', async () => {
    const a = await seedApp('app-a');
    const images = {
      input() {
        throw new Error('bad image');
      },
    };
    const bindings = {
      ...withAi(async () => json({ image: base64(PNG) })),
      IMAGES: images as unknown as ImagesBinding,
    };
    const res = await call(
      a.token,
      post('/ai/images', { model: 'm/x', prompt: 'p', output: { format: 'webp' } }),
      bindings
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Converting the image failed: bad image',
      code: 'ai_upstream_error',
    });
  });

  it('is 400 without a model or prompt', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(async () => new Response());
    const noPrompt = await call(a.token, post('/ai/images', { model: 'm/x' }), bindings);
    expect(noPrompt.status).toBe(400);
    const noModel = await call(a.token, post('/ai/images', { prompt: 'p' }), bindings);
    expect(noModel.status).toBe(400);
  });

  it('passes upstream 4xx responses through', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(async () => json({ error: 'bad size' }, { status: 400 }));
    const res = await call(a.token, post('/ai/images', { model: 'm/x', prompt: 'p' }), bindings);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad size' });
  });

  it('reports upstream failures as 502', async () => {
    const a = await seedApp('app-a');
    const down = await call(
      a.token,
      post('/ai/images', { model: 'm/x', prompt: 'p' }),
      withAi(async () => {
        throw new Error('model down');
      })
    );
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: 'model down', code: 'ai_upstream_error' });

    const empty = await call(
      a.token,
      post('/ai/images', { model: 'm/x', prompt: 'p' }),
      withAi(async () => json({ result: {} }))
    );
    expect(empty.status).toBe(502);
  });

  it('is 403 for an app with the AI proxy turned off', async () => {
    const a = await seedApp('app-a');
    await setAiProxy(env.DB, 'app-a', false);
    const calls: unknown[][] = [];
    const bindings = withAi(async (...args) => {
      calls.push(args);
      return new Response();
    });
    const res = await call(a.token, post('/ai/images', { model: 'm/x', prompt: 'p' }), bindings);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('AI decisions', () => {
  it('runs the model with the state and questions and returns its answers', async () => {
    const a = await seedApp('app-a');
    const calls: unknown[][] = [];
    const answers = { ripe: { type: 'noul', noul: 0.8 } };
    const bindings = withAi(async (...args) => {
      calls.push(args);
      return json({ result: { answers } });
    });
    const questions = { ripe: { type: 'noul', instructions: 'Is it ripe?' } };
    const res = await call(
      a.token,
      post('/ai/decide', { model: 'typesafe/jev', state: { fruit: 'banana' }, questions }),
      bindings
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answers });
    expect(calls[0]?.slice(0, 2)).toEqual([
      'typesafe/jev',
      { state: { fruit: 'banana' }, questions },
    ]);
  });

  it('is 400 without questions', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(async () => new Response());
    const res = await call(a.token, post('/ai/decide', { model: 'typesafe/jev' }), bindings);
    expect(res.status).toBe(400);
  });

  it('reports a response without answers as 502', async () => {
    const a = await seedApp('app-a');
    const bindings = withAi(async () => json({ result: { nope: true } }));
    const res = await call(
      a.token,
      post('/ai/decide', { model: 'typesafe/jev', questions: {} }),
      bindings
    );
    expect(res.status).toBe(502);
  });
});
