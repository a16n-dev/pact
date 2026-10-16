import type { BaseDocument } from '../types';
import type { DatabaseAdapter } from './adapter';

/**
 * Translates code-facing collection names to the physical keys from
 * `CollectionDefinition.key`, so everything above it deals only in names.
 * Names outside the map (internal `_*` collections, stale physical
 * collections from an older domain) pass through unchanged. With encryption
 * on, this must sit above `EncryptedAdapter` so envelopes are AAD-bound to
 * the key, which is what the wire layer seals against.
 */
export class AliasAdapter implements DatabaseAdapter {
  private readonly inner: DatabaseAdapter;
  private readonly nameToKey: ReadonlyMap<string, string>;
  private readonly keyToName: ReadonlyMap<string, string>;

  constructor(inner: DatabaseAdapter, nameToKey: ReadonlyMap<string, string>) {
    this.inner = inner;
    this.nameToKey = nameToKey;
    this.keyToName = new Map(Array.from(nameToKey, ([name, key]) => [key, name]));
  }

  private toKey(collection: string): string {
    return this.nameToKey.get(collection) ?? collection;
  }

  get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    return this.inner.get(this.toKey(collection), id);
  }

  getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    return this.inner.getMany(this.toKey(collection), ids);
  }

  getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    return this.inner.getAll(this.toKey(collection));
  }

  put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    return this.inner.put(this.toKey(collection), doc);
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    const key = this.toKey(collection);
    if (this.inner.putMany) return this.inner.putMany(key, docs);
    for (const doc of docs) await this.inner.put(key, doc);
  }

  delete(collection: string, id: string): Promise<void> {
    return this.inner.delete(this.toKey(collection), id);
  }

  wipe(): Promise<void> {
    return this.inner.wipe();
  }

  async listCollections(): Promise<string[]> {
    const keys = await this.inner.listCollections();
    return keys.map((key) => this.keyToName.get(key) ?? key);
  }
}
