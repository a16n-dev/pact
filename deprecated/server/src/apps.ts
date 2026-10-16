import dayjs from 'dayjs';
import type { Env } from './types';

// App names become R2 key prefixes, Durable Object names, and SQL values.
// No `/`: it would let one app's blob keys alias into another's R2 prefix.
const APP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidAppName(name: string): boolean {
  return APP_NAME_RE.test(name);
}

// Only runs on register/provision, never on token-authed requests. Encoded
// into each stored hash, so raising it does not invalidate existing rows.
const PBKDF2_ITERATIONS = 50_000;

// Verified against when the app does not exist, so an unknown app costs the
// same derivation as a real one and the uniform 401 cannot be used to probe
// which names are provisioned. Its result is always discarded.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashAppPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(hash)}`;
}

export async function verifyAppPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = unhex(parts[2]!);
  const expected = unhex(parts[3]!);
  const actual = await deriveBits(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  // Constant-time compare: no early-out on the first differing byte.
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

export async function resolveAppAuth(
  env: Env,
  appName: string,
  password: string
): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT password_hash FROM apps WHERE app_name = ?1`)
    .bind(appName)
    .first();
  // Always derive, even for a missing row, so unknown app and wrong password
  // are indistinguishable in both timing and response.
  const matched = await verifyAppPassword(password, (row?.password_hash as string) ?? DUMMY_HASH);
  return row !== null && matched;
}

// Rotating the password leaves client rows alone: tokens are bound to the
// app, not the password, so registered clients keep working.
export async function upsertApp(
  db: D1Database,
  appName: string,
  password: string
): Promise<{ created: boolean }> {
  const existing = await db
    .prepare(`SELECT app_name FROM apps WHERE app_name = ?1`)
    .bind(appName)
    .first();
  const passwordHash = await hashAppPassword(password);
  await db
    .prepare(
      `INSERT INTO apps (app_name, password_hash, created_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (app_name) DO UPDATE SET password_hash = excluded.password_hash`
    )
    .bind(appName, passwordHash, dayjs().toISOString())
    .run();
  return { created: existing === null };
}
