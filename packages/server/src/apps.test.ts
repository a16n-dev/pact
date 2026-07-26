import { describe, it, expect } from 'vitest';
import { isValidAppName, hashAppPassword, verifyAppPassword, resolveAppAuth } from './apps';
import type { Env } from './types';

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
  it('authenticates table apps by hash verify', async () => {
    const stored = await hashAppPassword('table-pw');
    const e = envWithAppsTable({}, { dyn: stored });
    expect(await resolveAppAuth(e, 'dyn', 'table-pw')).toBe(true);
    expect(await resolveAppAuth(e, 'dyn', 'nope')).toBe(false);
  });

  it('rejects unknown apps (uniform false, even against a real app name)', async () => {
    const stored = await hashAppPassword('pa');
    const e = envWithAppsTable({}, { a: stored });
    expect(await resolveAppAuth(e, 'ghost', 'pa')).toBe(false);
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
