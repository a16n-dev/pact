import type { AdapterRecord, DatabaseAdapter, StoredEntry } from '@a16n/pact-client';

type Row = { collection: string; id: string; record: AdapterRecord };

const STORE = 'records';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbAdapter implements DatabaseAdapter {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(
    name = 'pact',
    factory: IDBFactory = globalThis.indexedDB
  ): Promise<IndexedDbAdapter> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ['collection', 'id'] });
        store.createIndex('byCollection', 'collection');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IndexedDbAdapter(db);
  }

  close(): void {
    this.db.close();
  }

  // An IndexedDB transaction auto-commits once no requests are pending, so it
  // cannot be held across an await. Every call opens its own.
  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async get(collection: string, id: string): Promise<AdapterRecord | null> {
    const row = await request<Row | undefined>(this.store('readonly').get([collection, id]));
    return row?.record ?? null;
  }

  async getMany(collection: string, ids: readonly string[]): Promise<StoredEntry[]> {
    const store = this.store('readonly');
    const rows = await Promise.all(
      ids.map((id) => request<Row | undefined>(store.get([collection, id])))
    );
    return rows.filter((row): row is Row => row !== undefined).map(toEntry);
  }

  async getAll(collection: string): Promise<StoredEntry[]> {
    const rows = await request<Row[]>(
      this.store('readonly').index('byCollection').getAll(collection)
    );
    return rows.map(toEntry);
  }

  async put(collection: string, id: string, record: AdapterRecord): Promise<void> {
    await request(this.store('readwrite').put({ collection, id, record }));
  }

  async putMany(collection: string, entries: readonly StoredEntry[]): Promise<void> {
    // All puts are issued synchronously on one transaction, so the batch is atomic.
    const store = this.store('readwrite');
    await Promise.all(
      entries.map(({ id, record }) => request(store.put({ collection, id, record })))
    );
  }

  async delete(collection: string, id: string): Promise<void> {
    await request(this.store('readwrite').delete([collection, id]));
  }

  async wipe(): Promise<void> {
    await request(this.store('readwrite').clear());
  }

  async listCollections(): Promise<string[]> {
    const index = this.store('readonly').index('byCollection');
    const collections: string[] = [];
    await new Promise<void>((resolve, reject) => {
      // 'nextunique' visits each distinct collection once instead of every record.
      const req = index.openKeyCursor(null, 'nextunique');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        collections.push(String(cursor.key));
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return collections;
  }
}

function toEntry(row: Row): StoredEntry {
  return { id: row.id, record: row.record };
}
