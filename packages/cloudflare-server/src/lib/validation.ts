import { z } from 'zod';

// App IDs become R2 key prefixes, Durable Object names and SQL values, so the charset is locked
// down at every door one can enter through. Notably no `/`, which would let one app's blob keys
// alias into another's prefix.
export const appIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const usernameSchema = z.string().min(1).max(64);
export const passwordSchema = z.string().min(8).max(256);
// App names, token labels and device names.
export const labelSchema = z.string().min(1).max(100);

export function isValidAppId(value: unknown): value is string {
  return appIdSchema.safeParse(value).success;
}

export function isValidDeviceId(value: unknown): value is string {
  return deviceIdSchema.safeParse(value).success;
}

export function isValidUsername(value: unknown): value is string {
  return usernameSchema.safeParse(value).success;
}

export function isValidPassword(value: unknown): value is string {
  return passwordSchema.safeParse(value).success;
}

export function isValidLabel(value: unknown): value is string {
  return labelSchema.safeParse(value).success;
}
