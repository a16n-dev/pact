import dayjs from 'dayjs';
import type { Env } from './types';

/**
 * App names become R2 key prefixes, Durable Object names, and SQL values, so
 * the charset is locked down at the only doors an app name can enter through
 * (register + provisioning). Notably no `/` — that would let one app's blob
 * keys alias into another's prefix.
 */
const APP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidAppName(name: string): boolean {
  return APP_NAME_RE.test(name);
}

// --- Table-provisioned apps -------------------------------------------------
//
// Apps are created at runtime via `POST /apps` (guarded by the PROVISION_KEY
// secret) into the D1 `apps` table. Passwords are human-chosen and stored
// only as PBKDF2 hashes, so a database leak doesn't expose reusable
// credentials.

/**
 * PBKDF2 work factor. Native WebCrypto keeps this cheap in absolute terms,
 * and it only runs on register/claim (never on token-authed requests), so it
 * costs nothing on the hot path. Encoded into each stored hash, so it can be
 * raised later without invalidating existing rows.
 */
const PBKDF2_ITERATIONS = 50_000;

/**
 * Verified against when the requested app exists nowhere, so an unknown app
 * costs the same PBKDF2 derivation as a real one and the uniform 401 can't
 * be used to probe which app names are provisioned. Never matches: the
 * result for a missing row is discarded (see `resolveAppAuth`).
 */
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

/** `pbkdf2$<iterations>$<salt-hex>$<hash-hex>` with a fresh random salt. */
export async function hashAppPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(hash)}`;
}

/** Constant-time verify of a password against a stored `pbkdf2$…` string. */
export async function verifyAppPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = unhex(parts[2]!);
  const expected = unhex(parts[3]!);
  const actual = await deriveBits(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/**
 * The single register-time credential check. Unknown apps still burn a full
 * PBKDF2 comparison (dummy hash) and return plain `false`, indistinguishable
 * from a wrong password — so the uniform 401 can't be used to probe which app
 * names are provisioned.
 */
export async function resolveAppAuth(
  env: Env,
  appName: string,
  password: string
): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT password_hash FROM apps WHERE app_name = ?1`)
    .bind(appName)
    .first();
  const matched = await verifyAppPassword(password, (row?.password_hash as string) ?? DUMMY_HASH);
  return row !== null && matched;
}

/**
 * Create an app or rotate its password (`POST /apps` body). Rotation doesn't
 * touch existing client rows — tokens are app-bound independently of the
 * password, so already-registered clients keep working.
 */
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
