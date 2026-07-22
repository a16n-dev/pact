// Every runnable recipe is held to the same contract suite. The browser
// recipes run against stand-ins (an in-memory Storage stub, fake-indexeddb);
// the expo-sqlite recipe runs against node:sqlite through a thin shim that
// implements its structural database interface — same SQL, different driver.
import 'fake-indexeddb/auto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describeAdapterContract } from './adapterContract';
import { JsonFileAdapter } from './jsonFileAdapter';
import { LocalStorageAdapter } from './localStorageAdapter';
import { IndexedDbAdapter } from './indexedDbAdapter';
import { NodeSqliteAdapter } from './nodeSqliteAdapter';
import { ExpoSqliteAdapter, type ExpoSqliteDatabase } from './expoSqliteAdapter';

describeAdapterContract('JsonFileAdapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pact-json-adapter-'));
  return {
    adapter: new JsonFileAdapter(join(dir, 'data.json')),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

class StorageStub {
  private entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return Array.from(this.entries.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
}

describeAdapterContract('LocalStorageAdapter', async () => ({
  adapter: new LocalStorageAdapter({ storage: new StorageStub() as unknown as Storage }),
}));

let idbDbCounter = 0;
describeAdapterContract('IndexedDbAdapter', async () => {
  const adapter = await IndexedDbAdapter.open(`pact-test-${idbDbCounter++}`);
  return { adapter, cleanup: () => adapter.close() };
});

describeAdapterContract('NodeSqliteAdapter', async () => {
  const adapter = new NodeSqliteAdapter(':memory:');
  return { adapter, cleanup: () => adapter.close() };
});

// node:sqlite wrapped in expo-sqlite's async surface, so the ExpoSqliteAdapter
// SQL runs for real without an Expo runtime.
function expoShim(db: DatabaseSync): ExpoSqliteDatabase {
  return {
    async execAsync(source) {
      db.exec(source);
    },
    async getFirstAsync<T>(source: string, ...params: (string | number | null)[]) {
      return ((db.prepare(source).get(...params) as T | undefined) ?? null) as T | null;
    },
    async getAllAsync<T>(source: string, ...params: (string | number | null)[]) {
      return db.prepare(source).all(...params) as T[];
    },
    async runAsync(source, ...params) {
      return db.prepare(source).run(...params);
    },
    async withTransactionAsync(task) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

describeAdapterContract('ExpoSqliteAdapter (via node:sqlite shim)', async () => {
  const db = new DatabaseSync(':memory:');
  return {
    adapter: await ExpoSqliteAdapter.create(expoShim(db)),
    cleanup: () => db.close(),
  };
});
