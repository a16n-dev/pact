import type { AdapterRecord, DatabaseAdapter, StoredEntry } from '@a16n/pact-client';

// Declared structurally so this file typechecks without `expo-sqlite` installed.
// In an app, delete this and pass the `SQLiteDatabase` from `openDatabaseAsync`.
export type ExpoSqliteDatabase = {
  execAsync(source: string): Promise<void>;
  getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
};

const TABLE = 'pact_records';

type Row = { id: string; record: string };

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
         record TEXT NOT NULL,
         PRIMARY KEY (collection, id)
       )`
    );
    return new ExpoSqliteAdapter(db);
  }

  async get(collection: string, id: string): Promise<AdapterRecord | null> {
    const row = await this.db.getFirstAsync<Row>(
      `SELECT id, record FROM ${TABLE} WHERE collection = ? AND id = ?`,
      collection,
      id
    );
    return row ? (JSON.parse(row.record) as AdapterRecord) : null;
  }

  async getMany(collection: string, ids: readonly string[]): Promise<StoredEntry[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await this.db.getAllAsync<Row>(
      `SELECT id, record FROM ${TABLE} WHERE collection = ? AND id IN (${placeholders})`,
      collection,
      ...ids
    );
    return rows.map(toEntry);
  }

  async getAll(collection: string): Promise<StoredEntry[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT id, record FROM ${TABLE} WHERE collection = ?`,
      collection
    );
    return rows.map(toEntry);
  }

  async put(collection: string, id: string, record: AdapterRecord): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO ${TABLE} (collection, id, record) VALUES (?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET record = excluded.record`,
      collection,
      id,
      JSON.stringify(record)
    );
  }

  async putMany(collection: string, entries: readonly StoredEntry[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const { id, record } of entries) await this.put(collection, id, record);
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

function toEntry(row: Row): StoredEntry {
  return { id: row.id, record: JSON.parse(row.record) as AdapterRecord };
}
