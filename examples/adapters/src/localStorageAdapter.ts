import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client';

/**
 * `DatabaseAdapter` backed by Web Storage (`localStorage` / `sessionStorage`).
 *
 * Good for small web apps and prototypes: zero dependencies, synchronous
 * storage, survives reloads. Not good once your data outgrows the ~5 MB
 * Storage quota or you need non-blocking IO — switch to the IndexedDB
 * recipe at that point.
 *
 * Layout: one Storage entry per document, keyed
 * `<prefix>:<collection>:<id>` (segments URI-encoded so separators in
 * names can't collide), holding the JSON-serialized doc.
 */
export class LocalStorageAdapter implements DatabaseAdapter {
  private readonly prefix: string;
  private readonly storage: Storage;

  constructor(opts?: { prefix?: string; storage?: Storage }) {
    this.prefix = opts?.prefix ?? 'pact';
    this.storage = opts?.storage ?? globalThis.localStorage;
  }

  private key(collection: string, id: string): string {
    return `${this.prefix}:${encodeURIComponent(collection)}:${encodeURIComponent(id)}`;
  }

  /** Decodes a Storage key of ours, or null for keys owned by someone else. */
  private parseKey(key: string): { collection: string; id: string } | null {
    if (!key.startsWith(`${this.prefix}:`)) return null;
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    return { collection: decodeURIComponent(parts[1]), id: decodeURIComponent(parts[2]) };
  }

  private ownKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key && this.parseKey(key)) keys.push(key);
    }
    return keys;
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const raw = this.storage.getItem(this.key(collection, id));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    const docs: T[] = [];
    for (const id of ids) {
      const doc = await this.get<T>(collection, id);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    const docs: T[] = [];
    for (const key of this.ownKeys()) {
      if (this.parseKey(key)?.collection !== collection) continue;
      const raw = this.storage.getItem(key);
      if (raw) docs.push(JSON.parse(raw) as T);
    }
    return docs;
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    this.storage.setItem(this.key(collection, doc.id), JSON.stringify(doc));
  }

  async delete(collection: string, id: string): Promise<void> {
    this.storage.removeItem(this.key(collection, id));
  }

  async wipe(): Promise<void> {
    for (const key of this.ownKeys()) this.storage.removeItem(key);
  }

  async listCollections(): Promise<string[]> {
    const collections = new Set<string>();
    for (const key of this.ownKeys()) collections.add(this.parseKey(key)!.collection);
    return Array.from(collections);
  }
}
