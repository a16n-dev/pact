import { describe, it, expect, vi } from 'vitest';

// index.ts re-exports RealtimeDO, whose `cloudflare:workers` import only
// resolves inside a Workers runtime — stub it so the Hono app is testable
// under plain vitest.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import { createSyncApp } from './index';
import type { Env } from './types';

/**
 * Fake env for exercising the register route end-to-end through Hono. The
 * fake DB records every INSERT's bound values so tests can assert which app
 * a client row was written under — or that nothing was written at all.
 */
function registerEnv() {
  const inserts: unknown[][] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO clients')) inserts.push(args);
            return {};
          },
          first: async () => null,
        }),
      }),
    },
    BLOBS: {},
    APPS: '{"app-a":"pa","app-b":"pb"}',
    SERVER_NAME: 'test',
    ENABLE_REALTIME: 'false',
  } as unknown as Env;
  return { env, inserts };
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

describe('POST /auth/register (multi-tenant)', () => {
  it("registers with the app's own password and stores the row under that app", async () => {
    const { env, inserts } = registerEnv();
    const res = await register(env, 'pa', BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { clientId: string; token: string };
    expect(json.clientId).toBe('cl-1');
    expect(json.token).toMatch(/^pact_/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![0]).toBe('app-a'); // app_name is the first bound value
  });

  it('rejects the wrong password for a known app', async () => {
    const { env, inserts } = registerEnv();
    const res = await register(env, 'wrong', BODY);
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0);
  });

  it("rejects one app's valid password used against another app", async () => {
    const { env, inserts } = registerEnv();
    const res = await register(env, 'pa', { ...BODY, appName: 'app-b' });
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0);
  });

  it('rejects an unknown app with the same 401 as a bad password', async () => {
    const { env, inserts } = registerEnv();
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

  it('serves a legacy API_KEY deployment as its default app', async () => {
    const { inserts } = registerEnv();
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              if (sql.includes('INSERT INTO clients')) inserts.push(args);
              return {};
            },
          }),
        }),
      },
      API_KEY: 'legacy-pw',
      DEFAULT_APP_NAME: 'fond',
      SERVER_NAME: 'test',
      ENABLE_REALTIME: 'false',
    } as unknown as Env;
    const res = await register(env, 'legacy-pw', { ...BODY, appName: 'fond' });
    expect(res.status).toBe(200);
    expect(inserts[0]![0]).toBe('fond');
  });
});
