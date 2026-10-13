import type { BaseDocument } from '../types';
import type { DatabaseAdapter } from './adapter';
import type { DocCipher } from '../crypto/types';
import { encryptDoc, decryptDoc, tryDecryptDoc } from '../crypto/docCrypto';

export interface EncryptedAdapterOptions {
  /**
   * `'throw'` (default): an envelope this key cannot open is fatal.
   * `'hide'`: such docs read as missing (`get` is null, `getMany` and `getAll`
   * omit them), so any key opens the store and sees only what it sealed.
   * Rows stay intact at rest either way.
   */
  onUndecryptable?: 'throw' | 'hide';
}

/**
 * Seals domain fields on write and opens them on read, so storage below holds
 * only base fields plus one ciphertext string while every layer above
 * (migrations, validation, LWW merge, blob extraction, backups) sees
 * plaintext. In `'hide'` mode an unopenable envelope must never surface
 * upward: a migration run against a doc with no domain fields would corrupt it.
 */
export class EncryptedAdapter implements DatabaseAdapter {
  private readonly inner: DatabaseAdapter;
  private readonly cipher: DocCipher;
  private readonly hideUndecryptable: boolean;

  constructor(inner: DatabaseAdapter, cipher: DocCipher, options?: EncryptedAdapterOptions) {
    this.inner = inner;
    this.cipher = cipher;
    this.hideUndecryptable = options?.onUndecryptable === 'hide';
  }

  // Internal `_*` collections (credentials, cursors, outbox) never sync, and
  // encrypting them would make the key-check value depend on the key it guards.
  private isPassthrough(collection: string): boolean {
    return collection.startsWith('_');
  }

  private decrypt<T extends BaseDocument>(
    collection: string,
    doc: BaseDocument
  ): Promise<T | null> {
    return this.hideUndecryptable
      ? tryDecryptDoc<T>(this.cipher, collection, doc)
      : decryptDoc<T>(this.cipher, collection, doc);
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const doc = await this.inner.get<BaseDocument>(collection, id);
    if (!doc) return null;
    if (this.isPassthrough(collection)) return doc as T;
    return this.decrypt<T>(collection, doc);
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    const docs = await this.inner.getMany<BaseDocument>(collection, ids);
    if (this.isPassthrough(collection)) return docs as T[];
    const opened: Array<T | null> = await Promise.all(
      docs.map((doc) => this.decrypt<T>(collection, doc))
    );
    return opened.filter((doc): doc is T => doc !== null);
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    const docs = await this.inner.getAll<BaseDocument>(collection);
    if (this.isPassthrough(collection)) return docs as T[];
    const opened: Array<T | null> = await Promise.all(
      docs.map((doc) => this.decrypt<T>(collection, doc))
    );
    return opened.filter((doc): doc is T => doc !== null);
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    if (this.isPassthrough(collection)) return this.inner.put(collection, doc);
    return this.inner.put(collection, await encryptDoc(this.cipher, collection, doc));
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    const write = async (sealed: BaseDocument[]) => {
      if (this.inner.putMany) await this.inner.putMany(collection, sealed);
      else for (const doc of sealed) await this.inner.put(collection, doc);
    };
    if (this.isPassthrough(collection)) return write(docs);
    return write(await Promise.all(docs.map((doc) => encryptDoc(this.cipher, collection, doc))));
  }

  delete(collection: string, id: string): Promise<void> {
    return this.inner.delete(collection, id);
  }

  wipe(): Promise<void> {
    return this.inner.wipe();
  }

  listCollections(): Promise<string[]> {
    return this.inner.listCollections();
  }
}
