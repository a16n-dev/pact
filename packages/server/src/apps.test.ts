import { describe, it, expect } from 'vitest';
import {
  getApps,
  getAppPassword,
  isValidAppName,
  hashAppPassword,
  verifyAppPassword,
  resolveAppAuth,
  LEGACY_DEFAULT_APP,
} from './apps';
import type { Env } from './types';

function env(fields: Partial<Env>): Env {
  return fields as Env;
}

/** Env whose DB serves a fixed `apps`-table row set. */
function envWithAppsTable(
  fields: Partial<Env>,
  rows: Record<string, string> // appName → password_hash
): Env {
  return {
    ...fields,
    DB: {
      prepare: (_sql: string) => ({
        bind: (name: string) => ({
          first: async () => (name in rows ? { app_name: name, password_hash: rows[name] } : null),
        }),
      }),
    },
  } as unknown as Env;
}

describe('getApps', () => {
  it('parses the APPS JSON roster', () => {
    expect(getApps(env({ APPS: '{"fond":"pw1","other":"pw2"}' }))).toEqual({
      fond: 'pw1',
      other: 'pw2',
    });
  });

  it('falls back to API_KEY as a single legacy app', () => {
    expect(getApps(env({ API_KEY: 'k' }))).toEqual({ [LEGACY_DEFAULT_APP]: 'k' });
    expect(getApps(env({ API_KEY: 'k', DEFAULT_APP_NAME: 'fond' }))).toEqual({ fond: 'k' });
  });

  it('prefers APPS over the legacy API_KEY when both are set', () => {
    expect(getApps(env({ APPS: '{"a":"pa"}', API_KEY: 'k' }))).toEqual({ a: 'pa' });
  });

  it('throws on invalid JSON, non-object rosters, bad names, and bad passwords', () => {
    expect(() => getApps(env({ APPS: 'not json' }))).toThrow('valid JSON');
    expect(() => getApps(env({ APPS: '["a"]' }))).toThrow('JSON object');
    expect(() => getApps(env({ APPS: '{"Bad Name":"pw"}' }))).toThrow('invalid app name');
    expect(() => getApps(env({ APPS: '{"a":""}' }))).toThrow('non-empty');
    expect(() => getApps(env({ APPS: '{"a":42}' }))).toThrow('non-empty string');
  });

  it('returns an empty roster when nothing is configured (table-only deployments)', () => {
    expect(getApps(env({}))).toEqual({});
  });
});

describe('hashAppPassword / verifyAppPassword', () => {
  it('round-trips and encodes the work factor', async () => {
    const stored = await hashAppPassword('hunter2');
    expect(stored).toMatch(/^pbkdf2\$50000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await verifyAppPassword('hunter2', stored)).toBe(true);
    expect(await verifyAppPassword('hunter3', stored)).toBe(false);
  });

  it('salts: hashing the same password twice gives different strings', async () => {
    expect(await hashAppPassword('pw')).not.toBe(await hashAppPassword('pw'));
  });

  it('rejects malformed stored values instead of throwing', async () => {
    expect(await verifyAppPassword('pw', 'not-a-hash')).toBe(false);
    expect(await verifyAppPassword('pw', 'pbkdf2$abc$00$00')).toBe(false);
    expect(await verifyAppPassword('pw', '')).toBe(false);
  });
});

describe('resolveAppAuth', () => {
  it('authenticates env-roster apps by plaintext compare', async () => {
    const e = envWithAppsTable({ APPS: '{"a":"pa"}' }, {});
    expect(await resolveAppAuth(e, 'a', 'pa')).toBe(true);
    expect(await resolveAppAuth(e, 'a', 'wrong')).toBe(false);
  });

  it('authenticates table apps by hash verify', async () => {
    const stored = await hashAppPassword('table-pw');
    const e = envWithAppsTable({}, { dyn: stored });
    expect(await resolveAppAuth(e, 'dyn', 'table-pw')).toBe(true);
    expect(await resolveAppAuth(e, 'dyn', 'nope')).toBe(false);
  });

  it('rejects unknown apps', async () => {
    const e = envWithAppsTable({ APPS: '{"a":"pa"}' }, {});
    expect(await resolveAppAuth(e, 'ghost', 'pa')).toBe(false);
  });

  it('the env roster wins over a table row with the same name', async () => {
    const stored = await hashAppPassword('table-pw');
    const e = envWithAppsTable({ APPS: '{"a":"env-pw"}' }, { a: stored });
    expect(await resolveAppAuth(e, 'a', 'env-pw')).toBe(true);
    expect(await resolveAppAuth(e, 'a', 'table-pw')).toBe(false);
  });
});

describe('getAppPassword', () => {
  const e = env({ APPS: '{"a":"pa","b":"pb"}' });

  it('returns the password for a known app and null for an unknown one', () => {
    expect(getAppPassword(e, 'a')).toBe('pa');
    expect(getAppPassword(e, 'nope')).toBeNull();
  });

  it('never resolves inherited Object properties as apps', () => {
    expect(getAppPassword(e, 'toString')).toBeNull();
    expect(getAppPassword(e, '__proto__')).toBeNull();
  });
});

describe('isValidAppName', () => {
  it('accepts lowercase alphanumerics with - and _', () => {
    expect(isValidAppName('fond')).toBe(true);
    expect(isValidAppName('my-app_2')).toBe(true);
    expect(isValidAppName('a')).toBe(true);
  });

  it('rejects names that could escape an R2 prefix or DO name', () => {
    expect(isValidAppName('')).toBe(false);
    expect(isValidAppName('a/b')).toBe(false);
    expect(isValidAppName('-leading')).toBe(false);
    expect(isValidAppName('UPPER')).toBe(false);
    expect(isValidAppName('spa ce')).toBe(false);
    expect(isValidAppName('x'.repeat(65))).toBe(false);
  });
});
