import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client';

/**
 * The slice of `expo-sqlite`'s `SQLiteDatabase` this adapter uses, declared
 * structurally so this recipe file has no dependency on `expo-sqlite` (this
 * repo can typecheck it, and you can read it without an Expo project). In
 * your app, delete this interface and use the real type:
 *
 *   import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
 *   const adapter = await ExpoSqliteAdapter.create(await openDatabaseAsync('my-app.db'));
 */
export interface ExpoSqliteDatabase {
  execAsync(source: string): Promise<void>;
  getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const TABLE = 'pact_documents';

/**
 * `DatabaseAdapter` backed by `expo-sqlite` — persistence for React Native /
 * Expo apps. Same one-table JSON-column layout as the `node:sqlite` recipe;
 * only the driver API differs (async methods instead of sync statements).
 *
 * Construction is async (the table must exist before first use), so use the
 * factory: `await ExpoSqliteAdapter.create(db)`.
 */
export class ExpoSqliteAdapter implements DatabaseAdapter {
  private readonly db: ExpoSqliteDatabase;

  private constructor(db: ExpoSqliteDatabase) {
    this.db = db;
  }

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
