// A registered app. `seq` is the app-wide counter that stamps every document version written.
export type AppRow = {
  id: string;
  name: string;
  seq: number;
  created_at: number;
};

// An app with the counts the admin panel lists.
export type AppSummary = AppRow & {
  token_count: number;
  document_count: number;
  blob_count: number;
  blob_bytes: number;
};

export async function getApp(db: D1Database, id: string): Promise<AppRow | null> {
  return db.prepare('SELECT id, name, seq, created_at FROM apps WHERE id = ?1').bind(id).first();
}

export async function listApps(db: D1Database): Promise<AppSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.seq, a.created_at,
         (SELECT COUNT(*) FROM tokens t WHERE t.app_id = a.id) AS token_count,
         (SELECT COUNT(*) FROM documents d WHERE d.app_id = a.id) AS document_count,
         (SELECT COUNT(*) FROM blobs b WHERE b.app_id = a.id) AS blob_count,
         (SELECT COALESCE(SUM(size), 0) FROM blobs b WHERE b.app_id = a.id) AS blob_bytes
       FROM apps a ORDER BY a.created_at`
    )
    .all<AppSummary>();
  return results;
}

export async function createApp(
  db: D1Database,
  id: string,
  name: string
): Promise<{ created: boolean }> {
  // `seq` starts at the creation time so a recreated app's counter is above anything a deleted
  // app with the same ID could have reached; devices holding an old cursor then still see
  // every new write.
  const now = Date.now();
  const result = await db
    .prepare('INSERT OR IGNORE INTO apps (id, name, seq, created_at) VALUES (?1, ?2, ?3, ?3)')
    .bind(id, name, now)
    .run();
  return { created: result.meta.changes === 1 };
}

export async function renameApp(db: D1Database, id: string, name: string): Promise<void> {
  await db.prepare('UPDATE apps SET name = ?2 WHERE id = ?1').bind(id, name).run();
}

export async function listRedirectUris(db: D1Database, appId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT uri FROM app_redirect_uris WHERE app_id = ?1 ORDER BY uri')
    .bind(appId)
    .all<{ uri: string }>();
  return results.map((row) => row.uri);
}

export async function addRedirectUri(db: D1Database, appId: string, uri: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO app_redirect_uris (app_id, uri) VALUES (?1, ?2)')
    .bind(appId, uri)
    .run();
}

export async function removeRedirectUri(db: D1Database, appId: string, uri: string): Promise<void> {
  await db
    .prepare('DELETE FROM app_redirect_uris WHERE app_id = ?1 AND uri = ?2')
    .bind(appId, uri)
    .run();
}

export function deleteAppStatements(db: D1Database, appId: string): D1PreparedStatement[] {
  return [
    'DELETE FROM documents WHERE app_id = ?1',
    'DELETE FROM blobs WHERE app_id = ?1',
    'DELETE FROM tokens WHERE app_id = ?1',
    'DELETE FROM auth_codes WHERE app_id = ?1',
    'DELETE FROM app_redirect_uris WHERE app_id = ?1',
    'DELETE FROM apps WHERE id = ?1',
  ].map((sql) => db.prepare(sql).bind(appId));
}
