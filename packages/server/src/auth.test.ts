import { describe, it, expect } from 'vitest';
import { extractBearerToken, timingSafeEqual } from './auth';

describe('extractBearerToken', () => {
  it('returns null for missing or non-bearer headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
  });

  it('extracts and trims the token, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer  xyz  ')).toBe('xyz');
  });
});

describe('timingSafeEqual', () => {
  it('is true for equal strings', async () => {
    expect(await timingSafeEqual('correct horse', 'correct horse')).toBe(true);
  });

  it('is false for same-length but different strings', async () => {
    expect(await timingSafeEqual('secret', 'sxcret')).toBe(false);
  });

  it('is false for different lengths', async () => {
    expect(await timingSafeEqual('a', 'aaaaaa')).toBe(false);
  });
});
