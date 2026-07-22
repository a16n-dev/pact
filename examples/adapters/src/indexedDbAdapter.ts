import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client';

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

/**
 * `DatabaseAdapter` backed by IndexedDB — the right default for web apps:
 * async, no practical size limit, available in every browser and in web
 * workers. Zero dependencies (raw IndexedDB, no wrapper library).
 *
 * Layout: a single `documents` object store keyed `[collection, id]`, with
 * an index on `collection` for `getAll`/`listCollections`.
 *
 * Construction is async (IndexedDB opens with a request), so use the
 * factory: `const adapter = await IndexedDbAdapter.open('my-app')`.
 */
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

  /** Close the underlying connection (e.g. before deleting the database). */
  close(): void {
    this.db.close();
  }

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
    // One transaction for the batch: all-or-nothing, one commit.
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
    // Walk the collection index with unique keys only — one hop per
    // distinct collection rather than one per document.
    const index = this.store('readonly').index('byCollection');
    const collections: string[] = [];
    await new Promise<void>((resolve, reject) => {
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
