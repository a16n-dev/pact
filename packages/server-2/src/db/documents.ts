import { LIMITS } from '../limits';

export interface PushedDocument {
  collection: string;
  id: string;
  hlc: string;
  data: string;
}

interface DocumentRow extends PushedDocument {
  writer_id: string;
  seq: number;
}

// Each pushed row takes the next value of the app's counter. The counter is bumped by the batch
// size up front and each insert computes its own `seq` from the final value, so the batch is
// a single D1 transaction of N + 2 statements rather than 2N.
const BUMP_SEQ_SQL = 'UPDATE apps SET seq = seq + ?2 WHERE id = ?1';
const UPSERT_SQL = `
  INSERT INTO documents (app_id, collection, id, writer_id, hlc, data, seq)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT seq FROM apps WHERE id = ?1) - ?7)
  ON CONFLICT (app_id, collection, id, writer_id) DO UPDATE
    SET hlc = excluded.hlc, data = excluded.data, seq = excluded.seq`;
const READ_SEQ_SQL = 'SELECT seq FROM apps WHERE id = ?1';
const PULL_SQL = `
  SELECT collection, id, writer_id, hlc, seq, data FROM documents
  WHERE app_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`;
const PULL_COLLECTIONS_SQL = `
  SELECT collection, id, writer_id, hlc, seq, data FROM documents
  WHERE app_id = ?1 AND seq > ?2 AND collection IN (SELECT value FROM json_each(?4))
  ORDER BY seq LIMIT ?3`;
const PULL_ONE_SQL = `
  SELECT collection, id, writer_id, hlc, seq, data FROM documents
  WHERE app_id = ?1 AND collection = ?2 AND id = ?3 ORDER BY seq`;
const WIPE_SQL = 'DELETE FROM documents WHERE app_id = ?1';

export const DOCUMENT_SQL = [UPSERT_SQL, PULL_SQL, PULL_COLLECTIONS_SQL, PULL_ONE_SQL, WIPE_SQL];

export async function currentSeq(db: D1Database, appId: string): Promise<number> {
  const row = await db.prepare(READ_SEQ_SQL).bind(appId).first<{ seq: number }>();
  return row?.seq ?? 0;
}

export async function pushDocuments(
  db: D1Database,
  appId: string,
  writerId: string,
  docs: PushedDocument[]
): Promise<number> {
  const statements = [
    db.prepare(BUMP_SEQ_SQL).bind(appId, docs.length),
    ...docs.map((doc, i) =>
      db
        .prepare(UPSERT_SQL)
        .bind(appId, doc.collection, doc.id, writerId, doc.hlc, doc.data, docs.length - 1 - i)
    ),
    db.prepare(READ_SEQ_SQL).bind(appId),
  ];
  const results = await db.batch<{ seq: number }>(statements);
  return results.at(-1)!.results[0]!.seq;
}

export async function pullDocuments(
  db: D1Database,
  appId: string,
  cursor: number,
  collections: string[]
): Promise<{ documents: DocumentRow[]; cursor: number; hasMore: boolean }> {
  const limit = LIMITS.pullPageSize;
  const statement =
    collections.length === 0
      ? db.prepare(PULL_SQL).bind(appId, cursor, limit + 1)
      : db
          .prepare(PULL_COLLECTIONS_SQL)
          .bind(appId, cursor, limit + 1, JSON.stringify(collections));
  const { results } = await statement.all<DocumentRow>();
  const hasMore = results.length > limit;
  const documents = hasMore ? results.slice(0, limit) : results;
  return { documents, cursor: documents.at(-1)?.seq ?? cursor, hasMore };
}

export async function pullDocument(
  db: D1Database,
  appId: string,
  collection: string,
  id: string
): Promise<DocumentRow[]> {
  const { results } = await db.prepare(PULL_ONE_SQL).bind(appId, collection, id).all<DocumentRow>();
  return results;
}

export function wipeDocumentsStatement(db: D1Database, appId: string): D1PreparedStatement {
  return db.prepare(WIPE_SQL).bind(appId);
}
