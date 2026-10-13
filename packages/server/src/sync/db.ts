import type { SyncDocument, BlobRecord } from '../types';

// Every statement here is scoped by `app_name` — the tenant boundary. No
// unscoped variant exists on purpose: a caller physically cannot touch
// another app's rows through this module, and a test asserts every SQL
// constant names the column (see the tripwire test in api.test.ts).
//
// Documents are stored one row per (document, client): the server never
// merges, it only ever replaces the pushing client's own row. Concurrent
// versions from different clients ("siblings") sit side by side and every
// client folds them with the same deterministic rule on pull. The server
// stays schema-free — it never reads `data` to decide anything. The one
// comparison it makes is a client against *itself*: the upsert's WHERE keeps
// a client's own row from moving backwards when its pushes land out of
// order (a `pushAll` snapshot racing an optimistic drain, or a timed-out
// request arriving after its retry). Other clients' rows are never compared.
//
// `seq` is the server-assigned monotonic write sequence, per app (see the
// schema in the README). It's computed here, on the server, so the pull
// cursor never depends on a client's wall clock. Within a D1 `batch`,
// statements run sequentially in one transaction, so each `MAX(seq)+1`
// already sees the prior statement's insert. The unique `(app_name, seq)`
// index is the backstop: a counter bug fails loudly instead of silently
// corrupting pull cursors.
const UPSERT_SQL = `
  INSERT INTO documents (app_name, id, collection, client_id, updated_at, data, seq)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM documents WHERE app_name = ?1))
  ON CONFLICT (app_name, collection, id, client_id) DO UPDATE
    SET updated_at = excluded.updated_at,
        data = excluded.data,
        seq = excluded.seq
    WHERE excluded.updated_at >= documents.updated_at
`;

// Max documents one pull page returns. The client drains by re-pulling from
// the returned cursor until `hasMore` is false, so this bounds a single
// response (D1 result set, Worker memory, JSON payload) independent of how
// large the collection is or how far behind the puller has fallen — e.g. a
// first full sync. seq's strict monotonicity makes the page boundary exact:
// no row can slip between pages.
const PULL_PAGE_SIZE = 500;

// The pull cursor is app-wide: one `seq` watermark covers every collection,
// so a client syncs in one paged request rather than one per collection.
const PULL_SQL = `
  SELECT id, collection, client_id, updated_at, data, seq
  FROM documents
  WHERE app_name = ?1 AND seq > ?2
  ORDER BY seq ASC
  LIMIT ?3
`;

const PULL_BY_ID_SQL = `
  SELECT id, collection, client_id, updated_at, data, seq
  FROM documents
  WHERE app_name = ?1 AND collection = ?2 AND id = ?3
  ORDER BY seq ASC
`;

function rowToDocument(row: Record<string, unknown>): SyncDocument {
  return {
    id: row.id as string,
    collection: row.collection as string,
    clientId: row.client_id as string,
    updatedAt: row.updated_at as string,
    data: JSON.parse(row.data as string),
    seq: row.seq as number,
  };
}

/**
 * Write `docs` as `clientId`'s rows, replacing that client's previous row for
 * each document unless that row is already newer (see the WHERE above).
 * Other clients' rows for the same document are never touched.
 */
export async function upsertDocuments(
  db: D1Database,
  appName: string,
  clientId: string,
  docs: SyncDocument[]
): Promise<{ accepted: number }> {
  const statements = docs.map((doc) =>
    db
      .prepare(UPSERT_SQL)
      .bind(appName, doc.id, doc.collection, clientId, doc.updatedAt, JSON.stringify(doc.data))
  );

  const results = await db.batch(statements);
  // `meta.changes` is 0 only when the WHERE declined the write because this
  // client's stored row is newer — a benign no-op (the newer version is the
  // one that should win), not a failure.
  const accepted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  return { accepted };
}

/**
 * Every client's row for one document (its siblings), oldest write first.
 * Empty when no client has pushed it.
 */
export async function getDocumentSiblings(
  db: D1Database,
  appName: string,
  collection: string,
  id: string
): Promise<SyncDocument[]> {
  const result = await db.prepare(PULL_BY_ID_SQL).bind(appName, collection, id).all();
  return result.results.map((row) => rowToDocument(row as Record<string, unknown>));
}

const WIPE_DOCUMENTS_SQL = `DELETE FROM documents WHERE app_name = ?1`;
const WIPE_BLOB_RECORDS_SQL = `DELETE FROM blobs WHERE app_name = ?1`;

export async function wipeAllDocuments(db: D1Database, appName: string): Promise<void> {
  await db.prepare(WIPE_DOCUMENTS_SQL).bind(appName).run();
}

export async function wipeAllBlobRecords(db: D1Database, appName: string): Promise<void> {
  await db.prepare(WIPE_BLOB_RECORDS_SQL).bind(appName).run();
}

/**
 * One page of the app's document rows written after `cursor` (a server
 * `seq`), oldest first, across every collection. A page may carry several
 * rows for the same document (siblings) — the client folds them. Returns the
 * new cursor to persist (the highest `seq` in the page, or the input cursor
 * unchanged when the page is empty) and `hasMore` — whether rows beyond this
 * page remain. The caller drains by re-pulling from the returned cursor
 * while `hasMore` is true.
 */
export async function getDocumentsSince(
  db: D1Database,
  appName: string,
  cursor: number,
  limit: number = PULL_PAGE_SIZE
): Promise<{ documents: SyncDocument[]; cursor: number; hasMore: boolean }> {
  // Fetch one extra row to learn whether more remain without a second COUNT
  // query, then drop it from the page.
  const result = await db
    .prepare(PULL_SQL)
    .bind(appName, cursor, limit + 1)
    .all();
  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;

  let nextCursor = cursor;
  const documents = rows.map((row) => {
    const doc = rowToDocument(row as Record<string, unknown>);
    if (doc.seq! > nextCursor) nextCursor = doc.seq!;
    return doc;
  });

  return { documents, cursor: nextCursor, hasMore };
}

const UPSERT_BLOB_SQL = `
  INSERT INTO blobs (app_name, hash, mime_type, size, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (app_name, hash) DO NOTHING
`;

const LIST_BLOBS_SQL = `SELECT hash FROM blobs WHERE app_name = ?1`;

/**
 * Record that a blob exists. Idempotent: the hash is the content identity, so
 * a repeat upload keeps the first row (same bytes ⇒ same size; mime can't
 * change the identity) rather than churning metadata.
 */
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

/**
 * Every SQL statement this module issues, exported solely for the isolation
 * tripwire test: each must reference `app_name` so no query can ever span
 * tenants. Add new statements here when adding them above.
 */
export const ALL_SQL: readonly string[] = [
  UPSERT_SQL,
  PULL_SQL,
  PULL_BY_ID_SQL,
  UPSERT_BLOB_SQL,
  LIST_BLOBS_SQL,
  WIPE_DOCUMENTS_SQL,
  WIPE_BLOB_RECORDS_SQL,
];
