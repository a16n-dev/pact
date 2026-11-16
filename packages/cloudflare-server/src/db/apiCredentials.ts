export type ApiCredentialsRow = {
  base_url: string;
  fields: string;
  sealed: string;
  updated_at: number;
};

export async function getApiCredentials(
  db: D1Database,
  appId: string,
  name: string
): Promise<ApiCredentialsRow | null> {
  return db
    .prepare(
      'SELECT base_url, fields, sealed, updated_at FROM api_credentials WHERE app_id = ?1 AND name = ?2'
    )
    .bind(appId, name)
    .first();
}

export async function putApiCredentials(
  db: D1Database,
  appId: string,
  name: string,
  row: ApiCredentialsRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_credentials (app_id, name, base_url, fields, sealed, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (app_id, name) DO UPDATE SET
         base_url = excluded.base_url, fields = excluded.fields, sealed = excluded.sealed,
         updated_at = excluded.updated_at`
    )
    .bind(appId, name, row.base_url, row.fields, row.sealed, row.updated_at)
    .run();
}

export async function deleteApiCredentials(
  db: D1Database,
  appId: string,
  name: string
): Promise<void> {
  await db
    .prepare('DELETE FROM api_credentials WHERE app_id = ?1 AND name = ?2')
    .bind(appId, name)
    .run();
}
