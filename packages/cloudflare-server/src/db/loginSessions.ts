import { generateToken, sha256Hex } from '../lib/crypto';
import { LIMITS } from '../lib/limits';

export type LoginSessionUser = {
  id: string;
  username: string;
};

export async function createLoginSession(db: D1Database, userId: string): Promise<string> {
  const session = generateToken();
  await db
    .prepare('INSERT INTO login_sessions (session_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256Hex(session), userId, Date.now() + LIMITS.loginSessionTtlMs)
    .run();
  return session;
}

export async function lookupLoginSession(
  db: D1Database,
  session: string
): Promise<LoginSessionUser | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.username, s.expires_at
       FROM login_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.session_hash = ?1`
    )
    .bind(await sha256Hex(session))
    .first<LoginSessionUser & { expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

export async function deleteLoginSession(db: D1Database, session: string): Promise<void> {
  await db
    .prepare('DELETE FROM login_sessions WHERE session_hash = ?1 OR expires_at < ?2')
    .bind(await sha256Hex(session), Date.now())
    .run();
}
