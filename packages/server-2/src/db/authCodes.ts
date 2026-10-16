import { generateAuthCode, sha256Hex } from '../crypto';
import { LIMITS } from '../limits';

interface AuthCodeRow {
  app_id: string;
  user_id: string;
  device_id: string;
  device_name: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
}

export async function createAuthCode(
  db: D1Database,
  fields: Omit<AuthCodeRow, 'expires_at'>
): Promise<string> {
  const code = generateAuthCode();
  await db
    .prepare(
      `INSERT INTO auth_codes (code_hash, app_id, user_id, device_id, device_name, redirect_uri, code_challenge, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      await sha256Hex(code),
      fields.app_id,
      fields.user_id,
      fields.device_id,
      fields.device_name,
      fields.redirect_uri,
      fields.code_challenge,
      Date.now() + LIMITS.authCodeTtlMs
    )
    .run();
  return code;
}

// Deleting the row and reading it happen in one batch, so a code can only ever be redeemed once.
export async function consumeAuthCode(db: D1Database, code: string): Promise<AuthCodeRow | null> {
  const hash = await sha256Hex(code);
  const [read] = await db.batch<AuthCodeRow>([
    db
      .prepare(
        `SELECT app_id, user_id, device_id, device_name, redirect_uri, code_challenge, expires_at
         FROM auth_codes WHERE code_hash = ?1`
      )
      .bind(hash),
    db
      .prepare('DELETE FROM auth_codes WHERE code_hash = ?1 OR expires_at < ?2')
      .bind(hash, Date.now()),
  ]);
  const row = read?.results[0];
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}
