import { badRequest } from './errors';

export const LIMITS = {
  dataBytes: 1024 * 1024,
  blobBytes: 50 * 1024 * 1024,
  pullPageSize: 500,
  authCodeTtlMs: 60_000,
  lastSeenWriteIntervalMs: 5 * 60_000,
};

// App IDs become R2 key prefixes, Durable Object names and SQL values, so the charset is locked
// down at every door one can enter through. Notably no `/`, which would let one app's blob keys
// alias into another's prefix.
const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidAppId(value: unknown): value is string {
  return typeof value === 'string' && APP_ID_RE.test(value);
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_RE.test(value);
}

export function isValidUsername(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64;
}

export function isValidPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256;
}

export function isValidLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100;
}

export function requireString(
  value: unknown,
  name: string,
  { min = 1, max }: { min?: number; max: number }
): string {
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`);
  if (value.length < min || value.length > max) {
    throw badRequest(`${name} must be ${min}–${max} characters`);
  }
  return value;
}
