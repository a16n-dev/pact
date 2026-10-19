import { LIMITS } from '../lib/limits';

// Naming: a *document* is identified by (collection, id) and is the thing clients work with.
// The server never stores a document as a whole; it stores one *version* per writer (a token
// row ID), and a client merges a document's versions into the value it shows. Pull endpoints
// therefore return versions, and "pulling a document" means pulling all of its versions.

// A version as a client pushes it: its own latest state of one document.
export type PushedDocumentVersion = {
  collection: string;
  id: string;
  hlc: string;
  data: string;
};

// A stored version: one writer's latest state of one document, stamped with the app-wide
// sequence number assigned when it was written.
export type DocumentVersionRow = PushedDocumentVersion & {
  writer_id: string;
  seq: number;
};

export async function currentSeq(db: D1Database, appId: string): Promise<number> {
  const row = await db
    .prepare('SELECT seq FROM apps WHERE id = ?1')
    .bind(appId)
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

// Each pushed version takes the next value of the app's counter. The counter is bumped by the
// batch size up front and each insert computes its own `seq` from the final value, so the batch
// is a single D1 transaction of N + 2 statements rather than 2N.
export async function pushDocumentVersions(
  db: D1Database,
  appId: string,
  writerId: string,
  versions: PushedDocumentVersion[]
): Promise<number> {
  const statements = [
    db.prepare('UPDATE apps SET seq = seq + ?2 WHERE id = ?1').bind(appId, versions.length),
    ...versions.map((version, i) =>
      db
        .prepare(
          `INSERT INTO documents (app_id, collection, id, writer_id, hlc, data, seq)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT seq FROM apps WHERE id = ?1) - ?7)
           ON CONFLICT (app_id, collection, id, writer_id) DO UPDATE
             SET hlc = excluded.hlc, data = excluded.data, seq = excluded.seq`
        )
        .bind(
          appId,
          version.collection,
          version.id,
          writerId,
          version.hlc,
          version.data,
          versions.length - 1 - i
        )
    ),
    db.prepare('SELECT seq FROM apps WHERE id = ?1').bind(appId),
  ];
  const results = await db.batch<{ seq: number }>(statements);
  return results.at(-1)!.results[0]!.seq;
}

// Every version written after `cursor`, oldest first, optionally limited to some collections.
export async function pullDocumentVersions(
  db: D1Database,
  appId: string,
  cursor: number,
  collections: string[]
): Promise<{ versions: DocumentVersionRow[]; cursor: number; hasMore: boolean }> {
  const limit = LIMITS.pullPageSize;
  const statement =
    collections.length === 0
      ? db
          .prepare(
            `SELECT collection, id, writer_id, hlc, seq, data FROM documents
             WHERE app_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`
          )
          .bind(appId, cursor, limit + 1)
      : db
          .prepare(
            `SELECT collection, id, writer_id, hlc, seq, data FROM documents
             WHERE app_id = ?1 AND seq > ?2 AND collection IN (SELECT value FROM json_each(?4))
             ORDER BY seq LIMIT ?3`
          )
          .bind(appId, cursor, limit + 1, JSON.stringify(collections));
  const { results } = await statement.all<DocumentVersionRow>();
  const hasMore = results.length > limit;
  const versions = hasMore ? results.slice(0, limit) : results;
  return { versions, cursor: versions.at(-1)?.seq ?? cursor, hasMore };
}

// All versions of one document.
export async function pullDocument(
  db: D1Database,
  appId: string,
  collection: string,
  id: string
): Promise<DocumentVersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT collection, id, writer_id, hlc, seq, data FROM documents
       WHERE app_id = ?1 AND collection = ?2 AND id = ?3 ORDER BY seq`
    )
    .bind(appId, collection, id)
    .all<DocumentVersionRow>();
  return results;
}

export function wipeDocumentsStatement(db: D1Database, appId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM documents WHERE app_id = ?1').bind(appId);
}

export type CollectionStats = {
  collection: string;
  document_count: number;
  version_count: number;
  data_bytes: number;
};

export type DocumentStats = {
  document_count: number;
  version_count: number;
  writer_count: number;
  data_bytes: number;
  collections: CollectionStats[];
};

export async function documentStats(db: D1Database, appId: string): Promise<DocumentStats> {
  const [totals, collections] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS version_count,
           COUNT(DISTINCT collection || '/' || id) AS document_count,
           COUNT(DISTINCT writer_id) AS writer_count,
           COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS data_bytes
         FROM documents WHERE app_id = ?1`
      )
      .bind(appId)
      .first<Omit<DocumentStats, 'collections'>>(),
    db
      .prepare(
        `SELECT collection,
           COUNT(DISTINCT id) AS document_count,
           COUNT(*) AS version_count,
           COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS data_bytes
         FROM documents WHERE app_id = ?1
         GROUP BY collection ORDER BY document_count DESC, collection`
      )
      .bind(appId)
      .all<CollectionStats>(),
  ]);
  return {
    document_count: totals?.document_count ?? 0,
    version_count: totals?.version_count ?? 0,
    writer_count: totals?.writer_count ?? 0,
    data_bytes: totals?.data_bytes ?? 0,
    collections: collections.results,
  };
}
