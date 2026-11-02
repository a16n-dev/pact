import { generateId, hashPassword } from '../lib/crypto';

// A server-wide user account. Users are shared across apps; each app sees them through its own
// device tokens.
export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
};

// What the admin panel shows per user.
export type UserSummary = {
  id: string;
  username: string;
  created_at: number;
  token_count: number;
};

export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?1')
    .bind(username)
    .first();
}

export async function listUsers(db: D1Database): Promise<UserSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.username, u.created_at,
         (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id) AS token_count
       FROM users u ORDER BY u.created_at`
    )
    .all<UserSummary>();
  return results;
}

export async function createUser(
  db: D1Database,
  username: string,
  password: string
): Promise<{ created: boolean }> {
  const result = await db
    .prepare(
      'INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)'
    )
    .bind(generateId(), username, await hashPassword(password), Date.now())
    .run();
  return { created: result.meta.changes === 1 };
}

export async function resetPassword(
  db: D1Database,
  userId: string,
  password: string
): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1')
      .bind(userId, await hashPassword(password)),
    db.prepare('DELETE FROM login_sessions WHERE user_id = ?1').bind(userId),
  ]);
}

export async function deleteUser(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM tokens WHERE user_id = ?1')
    .bind(userId)
    .all<{ id: string }>();
  await db.batch([
    db.prepare('DELETE FROM tokens WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM auth_codes WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM app_users WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM login_sessions WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  ]);
  return results.map((row) => row.id);
}
