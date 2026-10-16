export interface BlobRow {
  hash: string;
  mime_type: string;
  size: number;
  created_at: number;
}

const UPSERT_SQL = `
  INSERT INTO blobs (app_id, hash, mime_type, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (app_id, hash) DO NOTHING`;
const LIST_HASHES_SQL = 'SELECT hash FROM blobs WHERE app_id = ?1';
const LIST_PAGE_SQL = `
  SELECT hash, mime_type, size, created_at FROM blobs
  WHERE app_id = ?1 AND hash > ?2 ORDER BY hash LIMIT ?3`;
const STATS_SQL =
  'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE app_id = ?1';
const WIPE_SQL = 'DELETE FROM blobs WHERE app_id = ?1';

export const BLOB_SQL = [UPSERT_SQL, LIST_HASHES_SQL, LIST_PAGE_SQL, STATS_SQL, WIPE_SQL];

export async function recordBlob(
  db: D1Database,
  appId: string,
  hash: string,
  mimeType: string,
  size: number
): Promise<void> {
  await db.prepare(UPSERT_SQL).bind(appId, hash, mimeType, size, Date.now()).run();
}

export async function listBlobHashes(db: D1Database, appId: string): Promise<string[]> {
  const { results } = await db.prepare(LIST_HASHES_SQL).bind(appId).all<{ hash: string }>();
  return results.map((row) => row.hash);
}

export async function listBlobPage(
  db: D1Database,
  appId: string,
  after: string,
  limit: number
): Promise<{ blobs: BlobRow[]; hasMore: boolean }> {
  const { results } = await db
    .prepare(LIST_PAGE_SQL)
    .bind(appId, after, limit + 1)
    .all<BlobRow>();
  const hasMore = results.length > limit;
  return { blobs: hasMore ? results.slice(0, limit) : results, hasMore };
}

export async function blobStats(
  db: D1Database,
  appId: string
): Promise<{ count: number; bytes: number }> {
  const row = await db.prepare(STATS_SQL).bind(appId).first<{ count: number; bytes: number }>();
  return row ?? { count: 0, bytes: 0 };
}

export function wipeBlobsStatement(db: D1Database, appId: string): D1PreparedStatement {
  return db.prepare(WIPE_SQL).bind(appId);
}
