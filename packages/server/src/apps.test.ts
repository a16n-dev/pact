import { describe, it, expect } from 'vitest';
import { getApps, getAppPassword, isValidAppName, LEGACY_DEFAULT_APP } from './apps';
import type { Env } from './types';

function env(fields: Partial<Env>): Env {
  return fields as Env;
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

  it('throws when nothing is configured', () => {
    expect(() => getApps(env({}))).toThrow('No apps configured');
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
