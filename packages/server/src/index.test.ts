import { describe, it, expect, vi } from 'vitest';

// index.ts re-exports RealtimeDO, whose `cloudflare:workers` import only
// resolves inside a Workers runtime — stub it so the Hono app is testable
// under plain vitest.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import { createSyncApp } from './index';
import type { Env } from './types';

/**
 * Fake env for exercising the register + provisioning routes end-to-end
 * through Hono. The fake DB records every client INSERT's bound values so
 * tests can assert which app a client row was written under — or that
 * nothing was written at all — and holds a live `apps` table that starts
 * empty: apps only come into existence by going through `POST /apps`, so
 * tests provision the same way a real deployment does.
 */
function registerEnv(extra: Partial<Env> = {}) {
  const inserts: unknown[][] = [];
  const apps = new Map<string, { app_name: string; password_hash: string }>();
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO clients')) inserts.push(args);
            if (sql.includes('INSERT INTO apps')) {
              apps.set(args[0] as string, {
                app_name: args[0] as string,
                password_hash: args[1] as string,
              });
            }
            return {};
          },
          first: async () => {
            if (sql.includes('FROM apps')) return apps.get(args[0] as string) ?? null;
            return null;
          },
        }),
      }),
    },
    BLOBS: {},
    SERVER_NAME: 'test',
    ENABLE_REALTIME: 'false',
    ...extra,
  } as unknown as Env;
  return { env, inserts, apps };
}

function register(env: Env, password: string, body: Record<string, unknown>) {
  return createSyncApp().request(
    '/auth/register',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

const BODY = { appName: 'app-a', clientId: 'cl-1', clientName: 'Test Device' };

/** Provision an app the only way one can exist: through `POST /apps`. */
function provision(env: Env, appName: string, password: string) {
  return claim(env, 'master', { appName, password });
}

describe('POST /auth/register (multi-tenant)', () => {
  it("registers with the app's own password and stores the row under that app", async () => {
    const { env, inserts } = registerEnv({ PROVISION_KEY: 'master' });
    await provision(env, 'app-a', 'pa');
    const res = await register(env, 'pa', BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { clientId: string; token: string };
    expect(json.clientId).toBe('cl-1');
    expect(json.token).toMatch(/^pact_/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![0]).toBe('app-a'); // app_name is the first bound value
  });

  it('rejects the wrong password for a known app', async () => {
    const { env, inserts } = registerEnv({ PROVISION_KEY: 'master' });
    await provision(env, 'app-a', 'pa');
    const res = await register(env, 'wrong', BODY);
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0);
  });

  it("rejects one app's valid password used against another app", async () => {
    const { env, inserts } = registerEnv({ PROVISION_KEY: 'master' });
    await provision(env, 'app-a', 'pa');
    await provision(env, 'app-b', 'pb');
    const res = await register(env, 'pa', { ...BODY, appName: 'app-b' });
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an unknown app with the same 401 as a bad password', async () => {
    const { env, inserts } = registerEnv({ PROVISION_KEY: 'master' });
    // Deliberately not provisioned — the app simply doesn't exist.
    const res = await register(env, 'pa', { ...BODY, appName: 'no-such-app' });
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a missing or malformed appName with a 400', async () => {
    const { env } = registerEnv();
    const missing = await register(env, 'pa', { clientId: 'cl-1', clientName: 'Test Device' });
    expect(missing.status).toBe(400);
    const malformed = await register(env, 'pa', { ...BODY, appName: 'Bad/Name' });
    expect(malformed.status).toBe(400);
  });
});

function claim(env: Env, key: string, body: Record<string, unknown>) {
  return createSyncApp().request(
    '/apps',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('POST /apps (dynamic provisioning)', () => {
  it('is disabled when PROVISION_KEY is not set', async () => {
    const { env } = registerEnv();
    const res = await claim(env, 'anything', { appName: 'dyn', password: 'pw' });
    expect(res.status).toBe(404);
  });

  it('rejects the wrong master key', async () => {
    const { env, apps } = registerEnv({ PROVISION_KEY: 'master' });
    const res = await claim(env, 'wrong', { appName: 'dyn', password: 'pw' });
    expect(res.status).toBe(401);
    expect(apps.has('dyn')).toBe(false);
  });

  it('creates an app, storing the password hashed', async () => {
    const { env, apps } = registerEnv({ PROVISION_KEY: 'master' });
    const res = await claim(env, 'master', { appName: 'dyn', password: 'dyn-pw' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ appName: 'dyn', created: true });
    const row = apps.get('dyn')!;
    expect(row.password_hash).toMatch(/^pbkdf2\$/);
    expect(row.password_hash).not.toContain('dyn-pw');
  });

  it('registers clients against a dynamically provisioned app', async () => {
    const { env, inserts } = registerEnv({ PROVISION_KEY: 'master' });
    await claim(env, 'master', { appName: 'dyn', password: 'dyn-pw' });

    const ok = await register(env, 'dyn-pw', { ...BODY, appName: 'dyn' });
    expect(ok.status).toBe(200);
    expect(inserts[0]![0]).toBe('dyn');

    const wrong = await register(env, 'not-it', { ...BODY, appName: 'dyn' });
    expect(wrong.status).toBe(401);
  });

  it('re-claiming rotates the password', async () => {
    const { env } = registerEnv({ PROVISION_KEY: 'master' });
    await claim(env, 'master', { appName: 'dyn', password: 'old-pw' });
    const res = await claim(env, 'master', { appName: 'dyn', password: 'new-pw' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appName: 'dyn', created: false });

    expect((await register(env, 'old-pw', { ...BODY, appName: 'dyn' })).status).toBe(401);
    expect((await register(env, 'new-pw', { ...BODY, appName: 'dyn' })).status).toBe(200);
  });

  it('validates the app name and password', async () => {
    const { env } = registerEnv({ PROVISION_KEY: 'master' });
    expect((await claim(env, 'master', { appName: 'Bad/Name', password: 'pw' })).status).toBe(400);
    expect((await claim(env, 'master', { appName: 'dyn', password: '' })).status).toBe(400);
    expect((await claim(env, 'master', { appName: 'dyn' })).status).toBe(400);
  });
});
