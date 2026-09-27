import type { BaseDocument } from '../types';
import type { DatabaseAdapter } from './adapter';
import type { DocCipher } from '../crypto/types';
import { encryptDoc, decryptDoc, tryDecryptDoc } from '../crypto/docCrypto';

/** How reads treat an envelope the cipher cannot open. */
export interface EncryptedAdapterOptions {
  /**
   * `'throw'` (default): a wrong key is fatal — the single-key model.
   * `'hide'`: undecryptable docs read as missing (`get` → null, `getMany`/
   * `getAll` filter them out), so any key opens the store and each key sees
   * only the subset it sealed. Rows stay intact at rest either way.
   */
  onUndecryptable?: 'throw' | 'hide';
}

/**
 * The at-rest encryption seam: wraps any DatabaseAdapter so documents are
 * sealed on write and opened on read — the underlying storage only ever
 * holds base sync fields plus one ciphertext string, and plaintext exists
 * only in memory. Everything above this wrapper (migrations, validation,
 * LWW merge, blob-reference extraction, backups) keeps seeing plaintext.
 *
 * Internal `_`-prefixed collections (credentials, cursors, outbox) pass
 * through unencrypted: they never sync, and encrypting them would make the
 * key-check value depend on the key that guards it. Non-envelope rows in
 * regular collections also read through unchanged, so enabling encryption on
 * an existing install degrades gracefully (see `Store.encryptLocalData`).
 *
 * In `'hide'` mode, undecryptable envelopes never surface above this wrapper
 * — the layers above (migrator especially) must only ever see plaintext, or
 * a migration would run against a doc with no domain fields.
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
