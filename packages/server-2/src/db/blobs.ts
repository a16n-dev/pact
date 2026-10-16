import { LIMITS } from '../lib/limits';

// One stored blob for an app. The bytes live in R2 under `<app_id>/<hash>`; this row records
// who first uploaded them. `user_id` and `device_id` are NULL when an API token did the upload.
export type BlobRow = {
  hash: string;
  mime_type: string;
  size: number;
  user_id: string | null;
  device_id: string | null;
  created_at: number;
};

export async function recordBlob(
  db: D1Database,
  appId: string,
  blob: Omit<BlobRow, 'created_at'>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blobs (app_id, hash, mime_type, size, user_id, device_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (app_id, hash) DO NOTHING`
    )
    .bind(appId, blob.hash, blob.mime_type, blob.size, blob.user_id, blob.device_id, Date.now())
    .run();
}

export async function listBlobHashes(db: D1Database, appId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT hash FROM blobs WHERE app_id = ?1')
    .bind(appId)
    .all<{ hash: string }>();
  return results.map((row) => row.hash);
}

export async function listBlobPage(
  db: D1Database,
  appId: string,
  after: string
): Promise<{ blobs: BlobRow[]; hasMore: boolean }> {
  const limit = LIMITS.blobPageSize;
  const { results } = await db
    .prepare(
      `SELECT hash, mime_type, size, user_id, device_id, created_at FROM blobs
       WHERE app_id = ?1 AND hash > ?2 ORDER BY hash LIMIT ?3`
    )
    .bind(appId, after, limit + 1)
    .all<BlobRow>();
  const hasMore = results.length > limit;
  return { blobs: hasMore ? results.slice(0, limit) : results, hasMore };
}

export async function blobStats(
  db: D1Database,
  appId: string
): Promise<{ count: number; bytes: number }> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE app_id = ?1'
    )
    .bind(appId)
    .first<{ count: number; bytes: number }>();
  return row ?? { count: 0, bytes: 0 };
}

export function wipeBlobsStatement(db: D1Database, appId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM blobs WHERE app_id = ?1').bind(appId);
}
