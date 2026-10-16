import type { SyncDocument, BlobRecord } from '../types';

// `seq` is assigned here, per app, so the pull cursor never depends on a
// client clock. Within a D1 batch each `MAX(seq)+1` sees the prior insert.
// A write the last-write-wins WHERE rejects leaves the row and its seq
// untouched. The unique `(app_name, seq)` index makes a counter bug fail
// loudly instead of corrupting cursors.
const UPSERT_SQL = `
  INSERT INTO documents (app_name, id, collection, updated_at, data, seq)
  VALUES (?1, ?2, ?3, ?4, ?5,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM documents WHERE app_name = ?1))
  ON CONFLICT (app_name, collection, id) DO UPDATE
    SET updated_at = excluded.updated_at,
        data = excluded.data,
        seq = excluded.seq
    WHERE excluded.updated_at >= documents.updated_at
`;

// Bounds one response regardless of collection size or how far behind the
// puller is; seq's strict monotonicity means no row can slip between pages.
const PULL_PAGE_SIZE = 500;

const PULL_SQL = `
  SELECT id, collection, updated_at, data, seq
  FROM documents
  WHERE app_name = ?1 AND collection = ?2 AND seq > ?3
  ORDER BY seq ASC
  LIMIT ?4
`;

const PULL_BY_ID_SQL = `
  SELECT id, collection, updated_at, data
  FROM documents
  WHERE app_name = ?1 AND collection = ?2 AND id = ?3
`;

export async function upsertDocuments(
  db: D1Database,
  appName: string,
  docs: SyncDocument[]
): Promise<{ accepted: number; skipped: number }> {
  const statements = docs.map((doc) =>
    db
      .prepare(UPSERT_SQL)
      .bind(appName, doc.id, doc.collection, doc.updatedAt, JSON.stringify(doc.data))
  );

  const results = await db.batch(statements);

  // `changes` is 0 when the last-write-wins guard declined the write because
  // the stored copy is newer-or-equal: a benign no-op, hence `skipped`.
  const accepted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);

  return { accepted, skipped: docs.length - accepted };
}

export async function getDocumentById(
  db: D1Database,
  appName: string,
  collection: string,
  id: string
): Promise<SyncDocument | null> {
  const row = await db.prepare(PULL_BY_ID_SQL).bind(appName, collection, id).first();
  if (!row) return null;
  return {
    id: row.id as string,
    collection: row.collection as string,
    updatedAt: row.updated_at as string,
    data: JSON.parse(row.data as string),
  };
}

const WIPE_DOCUMENTS_SQL = `DELETE FROM documents WHERE app_name = ?1`;
const WIPE_BLOB_RECORDS_SQL = `DELETE FROM blobs WHERE app_name = ?1`;

export async function wipeAllDocuments(db: D1Database, appName: string): Promise<void> {
  await db.prepare(WIPE_DOCUMENTS_SQL).bind(appName).run();
}

export async function wipeAllBlobRecords(db: D1Database, appName: string): Promise<void> {
  await db.prepare(WIPE_BLOB_RECORDS_SQL).bind(appName).run();
}

export async function getDocumentsSince(
  db: D1Database,
  appName: string,
  collection: string,
  cursor: number,
  limit: number = PULL_PAGE_SIZE
): Promise<{ documents: SyncDocument[]; cursor: number; hasMore: boolean }> {
  // Peek one row past the page to learn `hasMore` without a COUNT query.
  const result = await db
    .prepare(PULL_SQL)
    .bind(appName, collection, cursor, limit + 1)
    .all();
  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;

  let nextCursor = cursor;
  const documents = rows.map((row) => {
    const seq = row.seq as number;
    if (seq > nextCursor) nextCursor = seq;
    return {
      id: row.id as string,
      collection: row.collection as string,
      updatedAt: row.updated_at as string,
      data: JSON.parse(row.data as string),
    };
  });

  return { documents, cursor: nextCursor, hasMore };
}

// DO NOTHING: the hash is the content identity, so a repeat upload keeps the
// first row rather than churning metadata.
const UPSERT_BLOB_SQL = `
  INSERT INTO blobs (app_name, hash, mime_type, size, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (app_name, hash) DO NOTHING
`;

const LIST_BLOBS_SQL = `SELECT hash FROM blobs WHERE app_name = ?1`;

export async function upsertBlob(db: D1Database, appName: string, blob: BlobRecord): Promise<void> {
  await db
    .prepare(UPSERT_BLOB_SQL)
    .bind(appName, blob.hash, blob.mimeType, blob.size, blob.createdAt)
    .run();
}

export async function listBlobHashes(db: D1Database, appName: string): Promise<string[]> {
  const result = await db.prepare(LIST_BLOBS_SQL).bind(appName).all<{ hash: string }>();
  return result.results.map((row) => row.hash);
}

// Exported only for the tenant-isolation tripwire test, which asserts every
// statement references `app_name`. Add new statements here.
export const ALL_SQL: readonly string[] = [
  UPSERT_SQL,
  PULL_SQL,
  PULL_BY_ID_SQL,
  UPSERT_BLOB_SQL,
  LIST_BLOBS_SQL,
  WIPE_DOCUMENTS_SQL,
  WIPE_BLOB_RECORDS_SQL,
];
