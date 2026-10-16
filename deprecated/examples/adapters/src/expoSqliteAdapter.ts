import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client-1';

// Declared structurally so this file typechecks without `expo-sqlite` installed.
// In an app, delete this and pass the `SQLiteDatabase` from `openDatabaseAsync`.
export interface ExpoSqliteDatabase {
  execAsync(source: string): Promise<void>;
  getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const TABLE = 'pact_documents';

export class ExpoSqliteAdapter implements DatabaseAdapter {
  private readonly db: ExpoSqliteDatabase;

  private constructor(db: ExpoSqliteDatabase) {
    this.db = db;
  }

  // The table must exist before the first query, and expo-sqlite is async-only,
  // so construction goes through this factory instead of the constructor.
  static async create(db: ExpoSqliteDatabase): Promise<ExpoSqliteAdapter> {
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         collection TEXT NOT NULL,
         id TEXT NOT NULL,
         doc TEXT NOT NULL,
         PRIMARY KEY (collection, id)
       )`
    );
    return new ExpoSqliteAdapter(db);
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const row = await this.db.getFirstAsync<{ doc: string }>(
      `SELECT doc FROM ${TABLE} WHERE collection = ? AND id = ?`,
      collection,
      id
    );
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await this.db.getAllAsync<{ doc: string }>(
      `SELECT doc FROM ${TABLE} WHERE collection = ? AND id IN (${placeholders})`,
      collection,
      ...ids
    );
    return rows.map((row) => JSON.parse(row.doc) as T);
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    const rows = await this.db.getAllAsync<{ doc: string }>(
      `SELECT doc FROM ${TABLE} WHERE collection = ?`,
      collection
    );
    return rows.map((row) => JSON.parse(row.doc) as T);
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO ${TABLE} (collection, id, doc) VALUES (?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET doc = excluded.doc`,
      collection,
      doc.id,
      JSON.stringify(doc)
    );
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const doc of docs) await this.put(collection, doc);
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM ${TABLE} WHERE collection = ? AND id = ?`, collection, id);
  }

  async wipe(): Promise<void> {
    await this.db.execAsync(`DELETE FROM ${TABLE}`);
  }

  async listCollections(): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ collection: string }>(
      `SELECT DISTINCT collection FROM ${TABLE}`
    );
    return rows.map((row) => row.collection);
  }
}
