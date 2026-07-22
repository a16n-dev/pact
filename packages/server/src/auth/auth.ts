import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

export interface ClientRow {
  /**
   * Tenant the client registered under. Recorded once at registration and
   * thereafter the sole source of a request's app scope — never a
   * client-supplied header.
   */
  appName: string;
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export function generateClientToken(): string {
  return `pact_${nanoid(32)}`;
}

/**
 * SHA-256 hex of a token. Access tokens are stored hashed, never in plaintext,
 * so a database leak doesn't expose usable credentials. Tokens are
 * high-entropy random, so a plain digest (no salt/KDF) is sufficient.
 */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string equality via SHA-256 digests. Avoids leaking how many
 * leading bytes matched (a timing side-channel on the server password): the
 * digest compare is fixed-length with no early-out.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

export async function registerClient(
  db: D1Database,
  appName: string,
  id: string,
  name: string
): Promise<{ token: string }> {
  const token = generateClientToken();
  const tokenHash = await hashToken(token);
  const now = dayjs().toISOString();
  // Persist only the hash; the raw token is returned to the caller once and
  // never stored server-side. (The `token` column holds the hash.) Client ids
  // are only unique per app — the same id under a different app is a
  // different client, never an overwrite.
  await db
    .prepare(
      `INSERT INTO clients (app_name, id, name, token, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (app_name, id) DO UPDATE
         SET name = excluded.name,
             token = excluded.token,
             last_seen_at = excluded.last_seen_at`
    )
    .bind(appName, id, name, tokenHash, now)
    .run();
  return { token };
}

export async function lookupClientByToken(
  db: D1Database,
  token: string
): Promise<ClientRow | null> {
  const tokenHash = await hashToken(token);
  // Tokens are globally unique (high-entropy random, UNIQUE column), so the
  // token alone resolves both the client and its app — this lookup is where
  // every authenticated request acquires its tenant scope.
  const row = await db
    .prepare(
      `SELECT app_name, id, name, created_at, last_seen_at
       FROM clients
       WHERE token = ?1`
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  return {
    appName: row.app_name as string,
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string,
  };
}

export async function bumpClientLastSeen(
  db: D1Database,
  appName: string,
  id: string
): Promise<void> {
  await db
    .prepare(`UPDATE clients SET last_seen_at = ?3 WHERE app_name = ?1 AND id = ?2`)
    .bind(appName, id, dayjs().toISOString())
    .run();
}
