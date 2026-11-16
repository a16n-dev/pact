import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../src/app';
import { api, ORIGIN, seedApp } from './helpers';
import { setApiProxy } from '../src/db/apps';

const BASE_URL = 'https://api.example.test/v1';

const CREDENTIALS = {
  token: { in: 'header', name: 'Authorization', prefix: 'Bearer ', value: 'sk-secret' },
  project: { in: 'query', name: 'project', value: 'p-42' },
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

// `app.fetch` rather than SELF, so the upstream fetch stub is in this isolate.
async function call(token: string, name: string, body: unknown, bindings: typeof env = env) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/apis/${name}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    bindings,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function putCredentials(token: string, name = 'example', json: unknown = {}) {
  return api(`/apis/${name}/credentials`, token, {
    method: 'PUT',
    json: { baseUrl: BASE_URL, credentials: CREDENTIALS, ...(json as object) },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API vault', () => {
  it('stores credentials encrypted and reports only which fields are set', async () => {
    const a = await seedApp('app-a');
    expect((await putCredentials(a.token)).status).toBe(204);

    const row = await env.DB.prepare('SELECT * FROM api_credentials').first<{ sealed: string }>();
    expect(row!.sealed).not.toContain('sk-secret');

    const res = await api('/apis/example/credentials', a.token);
    expect(res.status).toBe(200);
    const status = (await res.json()) as Record<string, unknown>;
    expect(status).toEqual({
      baseUrl: BASE_URL,
      fields: ['project', 'token'],
      updatedAt: expect.any(Number),
    });
    expect(JSON.stringify(status)).not.toContain('sk-secret');
  });

  it('is 404 for an API without credentials, and after they are deleted', async () => {
    const a = await seedApp('app-a');
    expect((await api('/apis/example/credentials', a.token)).status).toBe(404);
    await putCredentials(a.token);
    expect((await api('/apis/example/credentials', a.token, { method: 'DELETE' })).status).toBe(
      204
    );
    expect((await api('/apis/example/credentials', a.token)).status).toBe(404);
  });

  it('keeps each app to its own credentials', async () => {
    const a = await seedApp('app-a');
    const b = await seedApp('app-b', ['https://b.example.test/callback']);
    await putCredentials(a.token);
    expect((await api('/apis/example/credentials', b.token)).status).toBe(404);
  });

  it('applies the credentials to the request and passes the response through', async () => {
    const a = await seedApp('app-a');
    await putCredentials(a.token);
    const calls = stubUpstream(() =>
      Response.json({ ok: true }, { status: 201, headers: { 'set-cookie': 'a=b' } })
    );
    const res = await call(a.token, 'example', {
      baseUrl: BASE_URL,
      method: 'POST',
      path: '/items/1',
      query: { expand: 'all', project: 'spoofed' },
      headers: { 'x-trace': 't1', authorization: 'Bearer spoofed' },
      body: { name: 'onion' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('pact-upstream-status')).toBe('201');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.has('set-cookie')).toBe(false);
    expect(await res.json()).toEqual({ ok: true });

    const upstream = calls[0]!;
    expect(upstream.url).toBe('https://api.example.test/v1/items/1?expand=all&project=p-42');
    expect(upstream.method).toBe('POST');
    expect(upstream.redirect).toBe('manual');
    expect(upstream.headers.get('authorization')).toBe('Bearer sk-secret');
    expect(upstream.headers.get('x-trace')).toBe('t1');
    expect(upstream.headers.get('content-type')).toBe('application/json');
    expect(await upstream.json()).toEqual({ name: 'onion' });
  });

  it("reports an upstream 401 in the header, not as the Pact token's 401", async () => {
    const a = await seedApp('app-a');
    await putCredentials(a.token);
    stubUpstream(() => new Response('bad key', { status: 401 }));
    const res = await call(a.token, 'example', { baseUrl: BASE_URL, method: 'GET', path: '/me' });
    expect(res.status).toBe(200);
    expect(res.headers.get('pact-upstream-status')).toBe('401');
    expect(await res.text()).toBe('bad key');
  });

  it('refuses a path that leaves the base URL', async () => {
    const a = await seedApp('app-a');
    await putCredentials(a.token);
    const calls = stubUpstream(() => new Response());
    for (const path of ['/../admin', '/%2e%2e/admin', '/..']) {
      const res = await call(a.token, 'example', { baseUrl: BASE_URL, method: 'GET', path });
      expect(res.status, path).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a call made for a different base URL than the credentials were saved for', async () => {
    const a = await seedApp('app-a');
    await putCredentials(a.token);
    const calls = stubUpstream(() => new Response());
    const res = await call(a.token, 'example', {
      baseUrl: 'https://evil.example.test',
      method: 'GET',
      path: '/',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('api_base_url_changed');
    expect(calls).toHaveLength(0);
  });

  it('rejects credentials that are not https or would set a framing header', async () => {
    const a = await seedApp('app-a');
    expect((await putCredentials(a.token, 'example', { baseUrl: 'http://x.test' })).status).toBe(
      400
    );
    const res = await putCredentials(a.token, 'example', {
      credentials: { host: { in: 'header', name: 'Host', value: 'evil.test' } },
    });
    expect(res.status).toBe(400);
  });

  it('is 403 for every route when the admin turns the proxy off', async () => {
    const a = await seedApp('app-a');
    await setApiProxy(env.DB, 'app-a', false);
    const res = await putCredentials(a.token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('api_disabled');
    expect((await api('/apis/example/credentials', a.token)).status).toBe(403);
  });

  it('is 503 when the server has no vault key', async () => {
    const a = await seedApp('app-a');
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ORIGIN}/apis/example/credentials`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: BASE_URL, credentials: CREDENTIALS }),
      }),
      { ...env, VAULT_KEY: undefined },
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });
});
