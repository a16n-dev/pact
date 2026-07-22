import { DatabaseSync } from 'node:sqlite';
import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client';

const TABLE = 'pact_documents';

/**
 * `DatabaseAdapter` backed by Node's built-in SQLite (`node:sqlite`,
 * Node ≥ 22.5) — real persistence for Node CLIs and desktop apps with zero
 * dependencies. Adapting this recipe to `better-sqlite3` is a
 * constructor-import rename: the prepare/get/all/run surface is the same.
 *
 * Layout: one table, one row per document, the doc JSON-serialized in a
 * `doc` column. Pact never queries inside documents (reads are by id or
 * whole-collection), so a JSON column is enough — no per-field schema.
 */
export class NodeSqliteAdapter implements DatabaseAdapter {
  private readonly db: DatabaseSync;

  /** @param path A file path, or `':memory:'` for an ephemeral store. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         collection TEXT NOT NULL,
         id TEXT NOT NULL,
         doc TEXT NOT NULL,
         PRIMARY KEY (collection, id)
       )`
    );
  }

  close(): void {
    this.db.close();
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const row = this.db
      .prepare(`SELECT doc FROM ${TABLE} WHERE collection = ? AND id = ?`)
      .get(collection, id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT doc FROM ${TABLE} WHERE collection = ? AND id IN (${placeholders})`)
      .all(collection, ...ids) as { doc: string }[];
    return rows.map((row) => JSON.parse(row.doc) as T);
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    const rows = this.db
      .prepare(`SELECT doc FROM ${TABLE} WHERE collection = ?`)
      .all(collection) as { doc: string }[];
    return rows.map((row) => JSON.parse(row.doc) as T);
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ${TABLE} (collection, id, doc) VALUES (?, ?, ?)
         ON CONFLICT (collection, id) DO UPDATE SET doc = excluded.doc`
      )
      .run(collection, doc.id, JSON.stringify(doc));
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO ${TABLE} (collection, id, doc) VALUES (?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET doc = excluded.doc`
    );
    this.db.exec('BEGIN');
    try {
      for (const doc of docs) insert.run(collection, doc.id, JSON.stringify(doc));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async delete(collection: string, id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${TABLE} WHERE collection = ? AND id = ?`).run(collection, id);
  }

  async wipe(): Promise<void> {
    this.db.exec(`DELETE FROM ${TABLE}`);
  }

  async listCollections(): Promise<string[]> {
    const rows = this.db.prepare(`SELECT DISTINCT collection FROM ${TABLE}`).all() as {
      collection: string;
    }[];
    return rows.map((row) => row.collection);
  }
}
