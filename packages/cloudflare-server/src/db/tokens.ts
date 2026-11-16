import { generateId, generateToken, sha256Hex, TOKEN_PREFIX_LENGTH } from '../lib/crypto';
import { LIMITS } from '../lib/limits';

// A bearer token for one app. Device tokens (issued by OAuth sign-in) carry the user and device;
// API tokens (minted in the admin panel) carry neither. The row ID doubles as the writer ID on
// documents. Only the token hash and a display prefix are stored.
type TokenRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  device_id: string | null;
  label: string;
  created_at: number;
  last_seen_at: number;
};

// A token joined with its user's name, as the bearer middleware sees it. `read_only` is the
// access the token has now: its own flag for API tokens, its user's for device tokens.
export type TokenWithUser = TokenRow & {
  username: string | null;
  read_only: number;
};

export async function lookupToken(db: D1Database, token: string): Promise<TokenWithUser | null> {
  return db
    .prepare(
      `SELECT t.id, t.app_id, t.user_id, t.device_id, t.label, t.created_at, t.last_seen_at,
              u.username,
              CASE WHEN t.user_id IS NULL THEN t.read_only
                   WHEN a.restricted = 1 THEN COALESCE(au.read_only, 0)
                   ELSE 0 END AS read_only
       FROM tokens t
       JOIN apps a ON a.id = t.app_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN app_users au ON au.app_id = t.app_id AND au.user_id = t.user_id
       WHERE t.token_hash = ?1`
    )
    .bind(await sha256Hex(token))
    .first();
}

export async function touchToken(db: D1Database, row: TokenRow): Promise<void> {
  const now = Date.now();
  if (now - row.last_seen_at < LIMITS.lastSeenWriteIntervalMs) return;
  await db.prepare('UPDATE tokens SET last_seen_at = ?2 WHERE id = ?1').bind(row.id, now).run();
}

export async function mintApiToken(
  db: D1Database,
  appId: string,
  label: string,
  readOnly = false
): Promise<{ token: string; id: string }> {
  const token = generateToken();
  const id = generateId();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO tokens (id, token_hash, token_prefix, app_id, user_id, device_id, label, created_at, last_seen_at, read_only)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?6, ?7)`
    )
    .bind(
      id,
      await sha256Hex(token),
      token.slice(0, TOKEN_PREFIX_LENGTH),
      appId,
      label,
      now,
      readOnly ? 1 : 0
    )
    .run();
  return { token, id };
}

// Signing in again from the same device rotates the token on its existing row, so the row's
// `id` (the writer ID) stays stable across sign-ins.
export async function issueDeviceToken(
  db: D1Database,
  appId: string,
  userId: string,
  deviceId: string,
  deviceName: string
): Promise<string> {
  const token = generateToken();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO tokens (id, token_hash, token_prefix, app_id, user_id, device_id, label, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (app_id, user_id, device_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         token_prefix = excluded.token_prefix,
         label = excluded.label,
         created_at = excluded.created_at,
         last_seen_at = excluded.last_seen_at`
    )
    .bind(
      generateId(),
      await sha256Hex(token),
      token.slice(0, TOKEN_PREFIX_LENGTH),
      appId,
      userId,
      deviceId,
      deviceName,
      now
    )
    .run();
  return token;
}

export async function deleteToken(db: D1Database, appId: string, tokenId: string): Promise<void> {
  await db.prepare('DELETE FROM tokens WHERE app_id = ?1 AND id = ?2').bind(appId, tokenId).run();
}

// What the admin panel shows per token.
type TokenSummary = {
  id: string;
  label: string;
  token_prefix: string;
  created_at: number;
  last_seen_at: number;
};

export type ApiTokenSummary = TokenSummary & {
  read_only: number;
};

export type DeviceTokenSummary = TokenSummary & {
  username: string;
};

export async function listAppTokens(
  db: D1Database,
  appId: string
): Promise<{ api: ApiTokenSummary[]; devices: DeviceTokenSummary[] }> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.label, t.token_prefix, t.created_at, t.last_seen_at, t.read_only, u.username
       FROM tokens t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.app_id = ?1 ORDER BY t.created_at`
    )
    .bind(appId)
    .all<ApiTokenSummary & { username: string | null }>();
  const api: ApiTokenSummary[] = [];
  const devices: DeviceTokenSummary[] = [];
  for (const row of results) {
    const { username, read_only, ...summary } = row;
    if (username === null) api.push({ ...summary, read_only });
    else devices.push({ ...summary, username });
  }
  return { api, devices };
}
