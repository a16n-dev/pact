import { describe, it, expect } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../src/app';
import { api, ORIGIN, seedApp } from './helpers';

function withAi(run: (...args: unknown[]) => Promise<Response>) {
  return { ...env, AI: { run } as unknown as Ai };
}

async function complete(token: string, ai: ReturnType<typeof withAi>, body: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/ai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ai,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('AI completions', () => {
  it('proxies to the gateway with app and token metadata and passes the response through', async () => {
    const a = await seedApp('app-a');
    const calls: unknown[][] = [];
    const ai = withAi(async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const body = { model: 'openai/gpt-4.1-mini', messages: [{ role: 'user', content: 'hello' }] };
    const res = await complete(a.token, ai, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { content: 'hi' } }] });
    expect(calls).toEqual([
      [
        'openai/gpt-4.1-mini',
        body,
        {
          gateway: { id: 'default', metadata: { app: 'app-a', token: a.tokenId } },
          returnRawResponse: true,
        },
      ],
    ]);
  });

  it('requires a model and reports upstream failures as 502', async () => {
    const a = await seedApp('app-a');
    const missing = await complete(
      a.token,
      withAi(async () => new Response()),
      { messages: [] }
    );
    expect(missing.status).toBe(400);
    const failing = await complete(
      a.token,
      withAi(async () => {
        throw new Error('gateway down');
      }),
      { model: 'openai/gpt-4.1-mini' }
    );
    expect(failing.status).toBe(502);
    expect(await failing.json()).toEqual({ error: 'gateway down', code: 'ai_upstream_error' });
  });

  it('runs any model by path with the body passed through', async () => {
    const a = await seedApp('app-a');
    const calls: unknown[][] = [];
    const ai = withAi(async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ result: { answers: {} } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const body = {
      state: { items: ['udon'] },
      questions: { q: { type: 'noul', instructions: 'Is it noodles?' } },
    };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ORIGIN}/ai/run/typesafe/jev`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      ai,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { answers: {} } });
    expect(calls).toEqual([
      [
        'typesafe/jev',
        body,
        {
          gateway: { id: 'default', metadata: { app: 'app-a', token: a.tokenId } },
          returnRawResponse: true,
        },
      ],
    ]);
  });

  it('rejects a non-object body', async () => {
    const a = await seedApp('app-a');
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ORIGIN}/ai/run/typesafe/jev`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: '[1]',
      }),
      withAi(async () => new Response()),
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('echoes requested headers for /ai preflights', async () => {
    const res = await api('/ai/chat/completions', null, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-headers': 'x-custom, authorization',
      },
    });
    expect(res.headers.get('access-control-allow-headers')).toBe('x-custom, authorization');
  });
});
