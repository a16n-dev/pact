import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client-1';

interface DocumentRow {
  collection: string;
  id: string;
  doc: BaseDocument;
}

const STORE = 'documents';

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

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const row = await request<DocumentRow | undefined>(
      this.store('readonly').get([collection, id])
    );
    return (row?.doc as T) ?? null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    const store = this.store('readonly');
    const rows = await Promise.all(
      ids.map((id) => request<DocumentRow | undefined>(store.get([collection, id])))
    );
    return rows.filter((row): row is DocumentRow => row !== undefined).map((row) => row.doc as T);
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    const rows = await request<DocumentRow[]>(
      this.store('readonly').index('byCollection').getAll(collection)
    );
    return rows.map((row) => row.doc as T);
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    await request(this.store('readwrite').put({ collection, id: doc.id, doc }));
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    // All puts are issued synchronously on one transaction, so the batch is atomic.
    const store = this.store('readwrite');
    await Promise.all(docs.map((doc) => request(store.put({ collection, id: doc.id, doc }))));
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
      // 'nextunique' visits each distinct collection once instead of every document.
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
