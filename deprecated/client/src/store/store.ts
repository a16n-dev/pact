import dayjs from 'dayjs';
import { z } from 'zod';
import { randomId } from '../ids';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';
import type { BaseDocument } from '../types';
import {
  SyncClient,
  registerClient as registerClientFetch,
  type RegisterResult,
  type SyncTransform,
} from '../sync/sync';
import { EncryptedAdapter } from '../adapters/encryptedAdapter';
import { AliasAdapter } from '../adapters/aliasAdapter';
import { encryptDoc, decryptDoc, tryDecryptDoc, isEncryptedDoc } from '../crypto/docCrypto';
import type { DocCipher } from '../crypto/types';
import { LOCAL_AUTHOR_ID, SYSTEM_AUTHOR_ID } from '../system';
import { RealtimeConnection } from '../sync/realtime';
import { Migrator } from '../migrator';
import {
  buildMigrationRegistry,
  createIdParser,
  type CollectionDefinition,
  type CollectionName,
  type CollectionIndexNames,
  type DocumentOf,
  type ParsedId,
} from '../collection';
import { IndexManager, normalizeKey, type IndexKeyInput } from './indexes';
import {
  packBackup,
  unpackBackup,
  BACKUP_FORMAT_VERSION,
  type BackupBlob,
} from '../backup/archive';
import { BlobSync } from '../blobs/blobSync';
import { SyncEngine } from './syncEngine';
import type { Collection } from './collectionRef';
import { seedContentEqual } from './helpers';
import type { StoreSyncConfig, StoreOptions, ChangeHandler, SeedSet } from './options';
import type {
  StoreSync,
  StoreAuthor,
  StoreBackup,
  StoreBlobs,
  StoreEncryption,
  ClientRegistration,
  RestoreMode,
  RestoreResult,
} from './namespaces';
import type { ClientConfigDoc, AuthorConfigDoc, SeedMarkerDoc, EncryptionCheckDoc } from './types';

// Any constant works: a wrong key fails to open the sealed check regardless of content.
const KEYCHECK_SENTINEL = 'pact-keycheck';
const KEYCHECK_AAD = '_config/encryption';

export class Store<Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[]> {
  private realtime: RealtimeConnection | null = null;
  private changeHandlers = new Set<ChangeHandler>();
  private readonly cipher: DocCipher | null;
  // Handed to every SyncClient so wire bodies carry the same ciphertext as local storage.
  private readonly wireTransform: SyncTransform | null;
  private cachedAuthorId: string = LOCAL_AUTHOR_ID;
  private adapter: DatabaseAdapter;
  // `encryption.onUndecryptable: 'hide'`: docs sealed under another key read as missing.
  private readonly hideUndecryptable: boolean;
  // The same adapter stack minus the cipher, so envelopes come back intact. Paths that only
  // need cleartext base fields (LWW timestamps) or must see docs this key can't open (backup,
  // push, hidden-row guards) read here. Identical to `adapter` on unencrypted stores.
  private readonly rawAdapter: DatabaseAdapter;
  private readonly migrator: Migrator;
  private readonly validate: (collection: string, doc: unknown) => unknown;
  private readonly definitions: ReadonlyMap<string, CollectionDefinition>;
  private readonly syncedCollections: readonly string[];
  // Null unless a definition sets a `key`. Everything inside the Store speaks names; the
  // AliasAdapter and SyncClient translate at the storage/wire boundary.
  private readonly collectionKeys: ReadonlyMap<string, string> | null;
  private readonly collectionNames: ReadonlyMap<string, string> | null;
  private readonly idParser: (id: string) => ParsedId | null;
  private readonly onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
  // Without an extractor blob GC cannot tell referenced from orphan and must refuse to run.
  private readonly blobHashesOf: (collection: string, doc: BaseDocument) => Iterable<string>;
  private readonly hasBlobRefs: boolean;
  private readonly syncEngine: SyncEngine;
  private readonly blobAdapter: BlobAdapter | null;
  private readonly indexes: IndexManager | null;

  readonly sync: StoreSync;
  readonly author: StoreAuthor;
  readonly backup: StoreBackup;
  readonly blobs: StoreBlobs;
  readonly encryption: StoreEncryption;

  constructor(options: StoreOptions<Defs>) {
    const domain = options;
    this.cipher = domain.encryption?.cipher ?? null;
    this.blobAdapter = options.blobs ?? null;
    const defs = domain.collections;
    this.definitions = new Map(defs.map((d) => [d.name, d]));
    if (this.definitions.size !== defs.length) {
      throw new Error('Duplicate collection name in StoreDomain.collections');
    }
    for (const def of defs) {
      if (def.name.startsWith('_')) {
        throw new Error(`Collection name "${def.name}" is reserved (the _* namespace is internal)`);
      }
    }
    if (new Set(defs.map((d) => d.key)).size !== defs.length) {
      throw new Error('Duplicate collection key in StoreDomain.collections');
    }
    const aliased = defs.filter((d) => d.key !== d.name);
    this.collectionKeys = aliased.length > 0 ? new Map(defs.map((d) => [d.name, d.key])) : null;
    this.collectionNames =
      this.collectionKeys !== null
        ? new Map(Array.from(this.collectionKeys, ([name, key]) => [key, name]))
        : null;
    // The cipher wraps the adapter before anything else touches it, so every layer above deals
    // in plaintext. The alias wrapper goes outermost so the cipher sees physical keys: envelopes
    // are AAD-bound to the same identity the wire seals against.
    this.hideUndecryptable = domain.encryption?.onUndecryptable === 'hide';
    let stacked = this.cipher
      ? new EncryptedAdapter(options.adapter, this.cipher, {
          onUndecryptable: domain.encryption?.onUndecryptable,
        })
      : options.adapter;
    let raw: DatabaseAdapter = options.adapter;
    if (this.collectionKeys) {
      stacked = new AliasAdapter(stacked, this.collectionKeys);
      raw = new AliasAdapter(raw, this.collectionKeys);
    }
    this.adapter = stacked;
    this.rawAdapter = this.cipher ? raw : this.adapter;
    this.wireTransform = this.cipher
      ? {
          toWire: (collection, doc) => encryptDoc(this.cipher!, collection, doc),
          // In hide mode an envelope another key sealed passes through still sealed; the sync
          // engine stores it raw so it survives locally without ever surfacing as plaintext.
          fromWire: this.hideUndecryptable
            ? async (collection, data) =>
                (await tryDecryptDoc(this.cipher!, collection, data as BaseDocument)) ??
                (data as BaseDocument)
            : (collection, data) => decryptDoc(this.cipher!, collection, data as BaseDocument),
        }
      : null;
    this.migrator = new Migrator(buildMigrationRegistry(defs));
    this.syncedCollections = defs.filter((d) => d.synced).map((d) => d.name);
    const indexManager = new IndexManager(defs);
    this.indexes = indexManager.isEmpty ? null : indexManager;
    this.idParser = createIdParser(defs);
    this.onSetAuthor = domain.onSetAuthor;
    this.hasBlobRefs = domain.blobHashes !== undefined;
    this.blobHashesOf = domain.blobHashes ?? (() => []);
    this.validate = (collection, doc) => {
      const stamped = {
        ...(doc as object),
        schemaVersion: this.migrator.currentVersion(collection),
      };
      // Internal `_*` docs carry no domain schema.
      const def = this.definitions.get(collection);
      return def ? def.schema.parse(stamped) : stamped;
    };
    this.syncEngine = new SyncEngine({
      adapter: this.adapter,
      rawAdapter: this.rawAdapter,
      migrator: this.migrator,
      collections: this.syncedCollections,
      getAuthorId: () => this.cachedAuthorId,
      emit: (collection) => this.emit(collection),
      persist: (collection, doc) => this.persist(collection, doc),
    });
    const creds = options.sync;
    this.syncEngine.setSyncClient(
      creds?.syncUrl && creds.syncToken
        ? new SyncClient(creds.syncUrl, creds.syncToken, this.wireTransform, this.collectionKeys)
        : null
    );
    if (creds?.syncUrl && creds?.syncToken) {
      this.openRealtime(creds.syncUrl, creds.syncToken);
    }

    this.sync = {
      push: async () => {
        await this.syncEngine.drainOutbox();
        await this.syncEngine.pushAll();
      },
      drain: () => this.syncEngine.drainOutbox(),
      pending: () => this.syncEngine.pendingPushCount(),
      resync: () => this.resyncFromScratch(),
      lastSyncedAt: (collections) => this.syncEngine.getLastSyncedAt(collections),
      register: (url, password, appName, clientName) =>
        this.registerClient(url, password, appName, clientName),
      registration: () => this.getClientRegistration(),
      credentials: () => this.getSyncCredentials(),
      unregister: () => this.clearClientRegistration(),
    };
    this.author = {
      get: async () => this.cachedAuthorId,
      set: (authorId) => this.setAuthor(authorId),
      reassignLocal: (newAuthorId) => this.reassignLocalAuthor(newAuthorId),
      wipe: (authorId) => this.wipeAuthor(authorId),
    };
    this.backup = {
      create: (opts) => this.createBackup(opts),
      restore: (archive, opts) => this.restoreBackup(archive, opts),
    };
    const blobSync = this.blobAdapter
      ? new BlobSync({
          adapter: this.blobAdapter,
          credentials: () => this.getSyncCredentials(),
          notifyChanged: () => this.notifyBlobsChanged(),
        })
      : null;
    const requireBlobs = (): BlobSync => {
      if (!blobSync) throw new Error('This store was created without a BlobAdapter');
      return blobSync;
    };
    this.blobs = {
      adapter: this.blobAdapter,
      write: (bytes, mimeType) => requireBlobs().write(bytes, mimeType),
      uri: (hash) => requireBlobs().uri(hash),
      has: (hash) => requireBlobs().has(hash),
      list: () => requireBlobs().list(),
      delete: (hash) => requireBlobs().delete(hash),
      push: () => requireBlobs().push(),
      pull: (referencedHashes) => requireBlobs().pull(referencedHashes),
      pullReferenced: async () => requireBlobs().pull(await this.referencedBlobHashes()),
      referencedHashes: () => this.referencedBlobHashes(),
      prune: () => this.pruneBlobs(),
      notifyChanged: () => this.notifyBlobsChanged(),
    };
    this.encryption = {
      verifyKey: () => this.verifyEncryptionKey(),
      encryptLocal: () => this.encryptLocalData(),
    };
  }

  // Always attempted: RealtimeConnection.start() probes `GET /info` and no-ops unless the server
  // advertises `realtime: true`, so the server alone decides whether a socket opens.
  private openRealtime(url: string, token: string): void {
    this.realtime?.stop();
    this.realtime = new RealtimeConnection({
      url,
      token,
      // The server broadcasts physical keys, so aliased domains translate back to names. `_*`
      // collections are per-store bookkeeping; pulling another party's copy would clobber ours.
      onInvalidate: (collection) => {
        const name = this.collectionNames?.get(collection) ?? collection;
        if (!name.startsWith('_')) void this.syncEngine.pull(name);
      },
      onReconnect: () => {
        void this.syncEngine.pullRegisteredCollections();
        void this.syncEngine.drainOutbox().catch(() => {});
      },
    });
    void this.realtime.start();
  }

  on(_event: 'change', handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  /** Closes the realtime socket. Document mutations and HTTP sync keep working afterwards. */
  dispose(): void {
    this.realtime?.stop();
    this.realtime = null;
  }

  private emit(collection: string): void {
    for (const handler of this.changeHandlers) handler(collection);
  }

  // Blob changes ride the document change channel so UI invalidation needs one subscription.
  private notifyBlobsChanged(): void {
    this.emit('_blobs');
  }

  private async referencedBlobHashes(): Promise<Set<string>> {
    const refs = new Set<string>();
    if (!this.hasBlobRefs) return refs;
    for (const collection of this.definitions.keys()) {
      const all = await this.adapter.getAll<BaseDocument>(collection);
      for (const raw of all) {
        if (raw.deletedAt) continue;
        // Migrated in memory (no write-back) so the extractor sees current field names; a stale
        // shape could miss a reference and mark a live blob as an orphan.
        const doc = this.migrator.needsMigration(collection, raw)
          ? this.migrator.migrate<BaseDocument>(collection, raw)
          : raw;
        for (const hash of this.blobHashesOf(collection, doc)) refs.add(hash);
      }
    }
    return refs;
  }

  private async hasHiddenDocs(): Promise<boolean> {
    for (const collection of this.definitions.keys()) {
      const readable = (await this.adapter.getAll<BaseDocument>(collection)).length;
      const total = (await this.rawAdapter.getAll<BaseDocument>(collection)).length;
      if (total > readable) return true;
    }
    return false;
  }

  // Local-only by design: deleting a shared, content-addressed blob server-side would break any
  // other device still referencing it, and LWW gives no safe moment to know every client has
  // dropped the reference. A pruned blob re-pulls if a referencing document arrives later.
  private async pruneBlobs(): Promise<{ deleted: string[] }> {
    if (!this.blobAdapter) return { deleted: [] };
    if (!this.hasBlobRefs) {
      throw new Error(
        'pruneBlobs requires a StoreDomain.blobHashes extractor; refusing to treat every blob as an orphan'
      );
    }
    // Hidden docs can't contribute their blob references, so their blobs would look orphaned.
    if (this.hideUndecryptable && (await this.hasHiddenDocs())) {
      throw new Error(
        'pruneBlobs refused: documents sealed under other encryption keys are present, ' +
          'and their blob references cannot be seen from this key'
      );
    }
    const referenced = await this.referencedBlobHashes();
    const deleted: string[] = [];
    for (const hash of await this.blobAdapter.list()) {
      if (referenced.has(hash)) continue;
      await this.blobAdapter.delete(hash);
      deleted.push(hash);
    }
    if (deleted.length > 0) this.notifyBlobsChanged();
    return { deleted };
  }

  static async create<Defs extends readonly CollectionDefinition[]>(
    options: StoreOptions<Defs>
  ): Promise<Store<Defs>> {
    const clientDoc = await options.adapter.get<ClientConfigDoc>('_config', 'client');
    const sync: StoreSyncConfig | undefined =
      options.sync ??
      (clientDoc ? { syncUrl: clientDoc.url, syncToken: clientDoc.token } : undefined);
    const store = new Store({ ...options, sync });
    const authorDoc = await options.adapter.get<AuthorConfigDoc>('_config', 'author');
    if (authorDoc) store.cachedAuthorId = authorDoc.authorId;
    await store.verifyEncryptionKey();
    await store.buildIndexes();
    return store;
  }

  private async buildIndexes(): Promise<void> {
    if (!this.indexes) return;
    this.indexes.clear();
    for (const collection of this.indexes.indexedCollections()) {
      const raw = await this.adapter.getAll<BaseDocument>(collection);
      for (const doc of raw) {
        const normalised = this.normalizeForIndex(collection, doc);
        if (normalised) this.indexes.onPersist(collection, normalised);
      }
    }
  }

  private async verifyEncryptionKey(): Promise<void> {
    if (!this.cipher) return;
    const existing = await this.adapter.get<EncryptionCheckDoc>('_config', 'encryption');
    // In hide mode there is no wrong key, but the sentinel is still written on first encrypted
    // use: apps use its existence as the "encryption has been enabled here" switch.
    if (existing && this.hideUndecryptable) return;
    if (!existing) {
      const now = dayjs().toISOString();
      await this.adapter.put<EncryptionCheckDoc>('_config', {
        id: 'encryption',
        schemaVersion: this.migrator.currentVersion('_config'),
        createdAt: now,
        updatedAt: now,
        createdBy: this.cachedAuthorId,
        updatedBy: this.cachedAuthorId,
        deletedAt: null,
        deletedBy: null,
        check: await this.cipher.seal(new TextEncoder().encode(KEYCHECK_SENTINEL), KEYCHECK_AAD),
      });
      return;
    }
    try {
      await this.cipher.open(existing.check, KEYCHECK_AAD);
    } catch {
      throw new Error(
        'Encryption key does not match the data in this store. ' +
          'The store was previously encrypted with a different key.'
      );
    }
  }

  private async encryptLocalData(): Promise<{ rewritten: number; skipped: number }> {
    if (!this.cipher) throw new Error('encryptLocalData requires the encryption option');
    let rewritten = 0;
    let skipped = 0;
    for (const collection of this.definitions.keys()) {
      // Reads decrypt (or pass plaintext through) and persist seals, so one round-trip re-encrypts
      // the lot. Hidden rows don't come back from the read and are already ciphertext.
      const docs = await this.adapter.getAll<BaseDocument>(collection);
      for (const doc of docs) {
        await this.persist(collection, doc);
        rewritten += 1;
      }
      if (this.hideUndecryptable) {
        const total = (await this.rawAdapter.getAll<BaseDocument>(collection)).length;
        skipped += total - docs.length;
      }
    }
    return { rewritten, skipped };
  }

  private async setAuthor(authorId: string): Promise<void> {
    if (authorId === SYSTEM_AUTHOR_ID) throw new Error('Cannot set author to the system author');
    if (authorId === LOCAL_AUTHOR_ID) {
      throw new Error('Cannot set author to the local author placeholder');
    }
    this.cachedAuthorId = authorId;
    const now = dayjs().toISOString();
    await this.adapter.put('_config', {
      id: 'author',
      schemaVersion: this.migrator.currentVersion('_config'),
      createdAt: now,
      updatedAt: now,
      createdBy: authorId,
      updatedBy: authorId,
      deletedAt: null,
      deletedBy: null,
      authorId,
    } as AuthorConfigDoc);
    await this.onSetAuthor?.(this, authorId);
  }

  private async getCurrentAuthor(): Promise<string> {
    return this.cachedAuthorId;
  }

  parseId(id: string): ParsedId | null {
    return this.idParser(id);
  }

  private async registerClient(
    url: string,
    password: string,
    appName: string,
    clientName: string
  ): Promise<RegisterResult> {
    const normalisedUrl = url.replace(/\/+$/, '');
    const existing = await this.adapter.get<ClientConfigDoc>('_config', 'client');
    // Re-registering (token rotation, rename, new URL) keeps the same server-side identity.
    const clientId = existing?.clientId ?? `cl-${randomId(10)}`;
    const result = await registerClientFetch(
      normalisedUrl,
      password,
      appName,
      clientId,
      clientName
    );
    if (!result.ok) return result;

    const now = dayjs().toISOString();
    const authorId = await this.getCurrentAuthor();
    await this.adapter.put('_config', {
      id: 'client',
      schemaVersion: this.migrator.currentVersion('_config'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? authorId,
      updatedBy: authorId,
      deletedAt: null,
      deletedBy: null,
      clientId,
      clientName,
      url: normalisedUrl,
      token: result.token,
      appName,
    } as ClientConfigDoc);
    this.syncEngine.setSyncClient(
      new SyncClient(normalisedUrl, result.token, this.wireTransform, this.collectionKeys)
    );
    this.openRealtime(normalisedUrl, result.token);
    return result;
  }

  private async getClientRegistration(): Promise<ClientRegistration | null> {
    const doc = await this.adapter.get<ClientConfigDoc>('_config', 'client');
    return doc
      ? { id: doc.clientId, name: doc.clientName, url: doc.url, appName: doc.appName ?? null }
      : null;
  }

  private async getSyncCredentials(): Promise<{ url: string; token: string } | null> {
    const doc = await this.adapter.get<ClientConfigDoc>('_config', 'client');
    return doc ? { url: doc.url, token: doc.token } : null;
  }

  private async clearClientRegistration(): Promise<void> {
    await this.adapter.delete('_config', 'client');
    this.syncEngine.setSyncClient(null);
    this.realtime?.stop();
    this.realtime = null;
  }

  /**
   * Clears all local data and resets to the unidentified local author. There is deliberately
   * no remote-wipe path: a single client credential must not be able to erase the shared
   * server database. Server data is wiped out-of-band by the operator.
   */
  async wipe(): Promise<void> {
    await this.adapter.wipe();
    this.indexes?.clear();
    this.cachedAuthorId = LOCAL_AUTHOR_ID;
  }

  private async wipeAuthor(authorId: string): Promise<void> {
    await Promise.all(
      Array.from(this.definitions.keys()).map(async (collection) => {
        const all = await this.adapter.getAll<BaseDocument>(collection);
        const ids = all.filter((d) => d.createdBy === authorId && !d.deletedAt).map((d) => d.id);
        if (ids.length > 0) await this.deleteMany(collection, ids);
      })
    );
  }

  private assertDefined(collection: string): void {
    if (collection.startsWith('_') || this.definitions.has(collection)) return;
    throw new Error(
      `Unknown collection "${collection}": every collection must be defined ` +
        '(with its schema) in StoreDomain.collections'
    );
  }

  private validateDoc<T>(collection: string, doc: T): T {
    this.assertDefined(collection);
    return this.validate(collection, doc) as T;
  }

  // Re-validation after migration reconstructs schema-typed values the storage format flattens,
  // notably `date()` fields persisted as ISO strings.
  private migrateRead<T>(collection: string, doc: T | null): T | null {
    if (!doc) return doc;
    let normalised: T = doc;
    if (this.migrator.needsMigration(collection, doc)) {
      normalised = this.migrator.migrate<T>(collection, doc);
      // Lazy write-back; failure isn't fatal, the next read migrates again.
      this.persist(collection, normalised as unknown as BaseDocument).catch(() => {});
    }
    try {
      return this.validate(collection, normalised) as T;
    } catch (err) {
      // A corrupt row degrades to a missing doc rather than bricking a whole list()/getMany().
      // TODO(alex): surface these via an `onInvalidDocument` hook.
      if (err instanceof z.ZodError) return null;
      throw err;
    }
  }

  private async requireAuthor(): Promise<string> {
    return this.getCurrentAuthor();
  }

  // Hide mode: a null decrypted read may mean a row sealed under another key, which writers that
  // treat "missing" as "free to create" (upsert, seed) must not overwrite.
  private async isHiddenRow(collection: string, id: string): Promise<boolean> {
    if (!this.hideUndecryptable) return false;
    const raw = await this.rawAdapter.get<BaseDocument>(collection, id);
    return raw !== null && isEncryptedDoc(raw);
  }

  private async reassignLocalAuthor(newAuthorId: string): Promise<void> {
    if (newAuthorId === LOCAL_AUTHOR_ID || newAuthorId === SYSTEM_AUTHOR_ID) {
      throw new Error('Cannot reassign local docs to a system or local author id');
    }
    const collections = await this.adapter.listCollections();
    const now = dayjs().toISOString();
    for (const collection of collections) {
      if (collection.startsWith('_')) continue;
      const all = await this.adapter.getAll<BaseDocument>(collection);
      for (const raw of all) {
        // `deletedBy` is included so a doc soft-deleted before identity was claimed doesn't sync a
        // tombstone still tagged with the local sentinel.
        if (
          raw.createdBy !== LOCAL_AUTHOR_ID &&
          raw.updatedBy !== LOCAL_AUTHOR_ID &&
          raw.deletedBy !== LOCAL_AUTHOR_ID
        ) {
          continue;
        }
        const doc = this.migrator.migrate<BaseDocument>(collection, raw);
        const updated: BaseDocument = {
          ...doc,
          createdBy: doc.createdBy === LOCAL_AUTHOR_ID ? newAuthorId : doc.createdBy,
          updatedBy: doc.updatedBy === LOCAL_AUTHOR_ID ? newAuthorId : doc.updatedBy,
          deletedBy: doc.deletedBy === LOCAL_AUTHOR_ID ? newAuthorId : doc.deletedBy,
          updatedAt: now,
        };
        await this.persist(collection, updated);
      }
      // Rows sealed under another key may also be local-authored. Author fields are cleartext
      // outside the envelope, so swap them in place; the write bypasses persist/indexing since
      // the doc isn't readable here.
      if (this.hideUndecryptable) {
        for (const raw of await this.rawAdapter.getAll<BaseDocument>(collection)) {
          if (!isEncryptedDoc(raw)) continue;
          if (
            raw.createdBy !== LOCAL_AUTHOR_ID &&
            raw.updatedBy !== LOCAL_AUTHOR_ID &&
            raw.deletedBy !== LOCAL_AUTHOR_ID
          ) {
            continue;
          }
          await this.rawAdapter.put(collection, {
            ...raw,
            createdBy: raw.createdBy === LOCAL_AUTHOR_ID ? newAuthorId : raw.createdBy,
            updatedBy: raw.updatedBy === LOCAL_AUTHOR_ID ? newAuthorId : raw.updatedBy,
            deletedBy: raw.deletedBy === LOCAL_AUTHOR_ID ? newAuthorId : raw.deletedBy,
            updatedAt: now,
          });
        }
      }
      this.emit(collection);
    }
  }

  private async get<T extends BaseDocument>(
    collection: string,
    id: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<T | null> {
    this.assertDefined(collection);
    this.syncEngine.triggerReadPull(collection);
    const doc = this.migrateRead<T>(collection, await this.adapter.get<T>(collection, id));
    if (!doc) return null;
    return doc.deletedAt && !opts?.includeDeleted ? null : doc;
  }

  private async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    this.assertDefined(collection);
    this.syncEngine.triggerReadPull(collection);
    const docs = await this.adapter.getMany<T>(collection, ids);
    return docs
      .map((doc) => this.migrateRead<T>(collection, doc))
      .filter((doc): doc is T => doc !== null && !doc.deletedAt);
  }

  private async list<T extends BaseDocument>(
    collection: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<T[]> {
    this.assertDefined(collection);
    this.syncEngine.triggerReadPull(collection);
    const all = await this.adapter.getAll<T>(collection);
    const docs = all
      .map((doc) => this.migrateRead<T>(collection, doc))
      .filter((doc): doc is T => doc !== null);
    return opts?.includeDeleted ? docs : docs.filter((doc) => !doc.deletedAt);
  }

  private async createAsSystem<T extends BaseDocument>(
    collection: string,
    input: Omit<T, keyof BaseDocument> & { id?: T['id'] }
  ): Promise<T> {
    const { id, ...rest } = input;
    const now = dayjs().toISOString();
    const doc = {
      ...rest,
      id: id ?? this.newId(collection),
      createdAt: now,
      updatedAt: now,
      createdBy: SYSTEM_AUTHOR_ID,
      updatedBy: SYSTEM_AUTHOR_ID,
      deletedAt: null,
      deletedBy: null,
    } as unknown as T;
    const validated = this.validateDoc(collection, doc);
    await this.persist(collection, validated);
    this.emit(collection);
    return validated;
  }

  /**
   * Applies a versioned seed payload; a no-op while the stored `_seeds` marker matches
   * `seeds.version` unless `force` is set. Docs still system-authored are overwritten when
   * their content changed. Docs a real author edited only gain fields that are `undefined` on
   * the doc: an explicit `null` is somebody's decision and is never overridden. Docs a real
   * author deleted stay deleted.
   */
  async seed(seeds: SeedSet, opts?: { force?: boolean }): Promise<{ written: number }> {
    const marker = await this.adapter.get<SeedMarkerDoc>('_seeds', 'current');
    if (!opts?.force && marker?.version === seeds.version) return { written: 0 };

    let written = 0;
    for (const [collection, docs] of seeds.docs) {
      const pending: BaseDocument[] = [];
      for (const { id, ...input } of docs) {
        const existing = this.migrateRead<BaseDocument>(
          collection,
          await this.adapter.get<BaseDocument>(collection, id)
        );
        if (!existing && (await this.isHiddenRow(collection, id))) continue;
        const now = dayjs().toISOString();
        let candidate: BaseDocument | null = null;
        if (!existing || existing.updatedBy === SYSTEM_AUTHOR_ID) {
          candidate = this.validateDoc(collection, {
            ...input,
            id,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            createdBy: SYSTEM_AUTHOR_ID,
            updatedBy: SYSTEM_AUTHOR_ID,
            deletedAt: null,
            deletedBy: null,
          } as BaseDocument);
        } else if (!existing.deletedAt) {
          const fills = Object.entries(input).filter(
            ([key, value]) =>
              value !== undefined &&
              (existing as unknown as Record<string, unknown>)[key] === undefined
          );
          if (fills.length > 0) {
            candidate = this.validateDoc(collection, {
              ...existing,
              ...Object.fromEntries(fills),
              updatedAt: now,
            } as BaseDocument);
          }
        }
        if (!candidate) continue;
        if (existing && seedContentEqual(existing, candidate)) continue;
        pending.push(candidate);
      }
      if (pending.length > 0) {
        await this.persistMany(collection, pending);
        written += pending.length;
        this.emit(collection);
      }
    }

    const now = dayjs().toISOString();
    await this.adapter.put<SeedMarkerDoc>('_seeds', {
      id: 'current',
      schemaVersion: this.migrator.currentVersion('_seeds'),
      createdAt: marker?.createdAt ?? now,
      updatedAt: now,
      createdBy: SYSTEM_AUTHOR_ID,
      updatedBy: SYSTEM_AUTHOR_ID,
      deletedAt: null,
      deletedBy: null,
      version: seeds.version,
    });
    return { written };
  }

  private newId(collection: string): string {
    const def = this.definitions.get(collection);
    if (!def) throw new Error(`Cannot generate an id for collection: ${collection}`);
    return def.generateId();
  }

  // Every write of a defined collection's doc funnels through persist/persistMany (tombstones
  // included) and every hard removal through remove, so derived state (indexes) has one place
  // to hook. Internal `_*` docs bypass these: no domain schema, no derived state.
  private async persist(collection: string, doc: BaseDocument): Promise<void> {
    await this.adapter.put(collection, doc);
    this.indexWrite(collection, doc);
  }

  private async persistMany(collection: string, docs: readonly BaseDocument[]): Promise<void> {
    if (docs.length === 0) return;
    if (this.adapter.putMany) await this.adapter.putMany(collection, docs as BaseDocument[]);
    else for (const doc of docs) await this.adapter.put(collection, doc);
    for (const doc of docs) this.indexWrite(collection, doc);
  }

  private async remove(collection: string, id: string): Promise<void> {
    await this.adapter.delete(collection, id);
    this.indexes?.onRemove(collection, id);
  }

  private indexWrite(collection: string, doc: BaseDocument): void {
    if (!this.indexes?.hasIndexesFor(collection)) return;
    const normalised = this.normalizeForIndex(collection, doc);
    if (normalised) this.indexes.onPersist(collection, normalised);
    // A doc that won't normalise is unreadable (list() would skip it), so it leaves the index.
    else this.indexes.onRemove(collection, doc.id);
  }

  private normalizeForIndex(collection: string, doc: BaseDocument): BaseDocument | null {
    const migrated = this.migrator.needsMigration(collection, doc)
      ? this.migrator.migrate<BaseDocument>(collection, doc)
      : doc;
    try {
      return this.validate(collection, migrated) as BaseDocument;
    } catch (err) {
      if (err instanceof z.ZodError) return null;
      throw err;
    }
  }

  private async create<T extends BaseDocument>(
    collection: string,
    input: Omit<T, keyof BaseDocument> & { id?: T['id'] }
  ): Promise<T> {
    const authorId = await this.requireAuthor();
    const { id, ...rest } = input;
    const now = dayjs().toISOString();
    const doc = {
      ...rest,
      id: id ?? this.newId(collection),
      createdAt: now,
      updatedAt: now,
      createdBy: authorId,
      updatedBy: authorId,
      deletedAt: null,
      deletedBy: null,
    } as unknown as T;
    const validated = this.validateDoc(collection, doc);
    await this.persist(collection, validated);
    await this.syncEngine.queuePush(collection, [validated.id]);
    this.emit(collection);
    return validated;
  }

  private async update<T extends BaseDocument>(
    collection: string,
    id: string,
    input: Partial<Omit<T, keyof BaseDocument>>
  ): Promise<T> {
    const authorId = await this.requireAuthor();
    const existing = this.migrateRead<T>(collection, await this.adapter.get<T>(collection, id));
    if (!existing) throw new Error(`Document not found: ${collection}/${id}`);
    const updated = {
      ...existing,
      ...input,
      id,
      createdAt: existing.createdAt,
      updatedAt: dayjs().toISOString(),
      createdBy: existing.createdBy,
      updatedBy: authorId,
    } as T;
    const validated = this.validateDoc(collection, updated);
    await this.persist(collection, validated);
    await this.syncEngine.queuePush(collection, [validated.id]);
    this.emit(collection);
    return validated;
  }

  private async upsert<T extends BaseDocument>(
    collection: string,
    input: Omit<T, keyof BaseDocument> & { id: T['id'] }
  ): Promise<T> {
    const authorId = await this.requireAuthor();
    const { id, ...rest } = input;
    const existing = this.migrateRead<T>(collection, await this.adapter.get<T>(collection, id));
    if (!existing && (await this.isHiddenRow(collection, id))) {
      throw new Error(
        `Cannot upsert ${collection}/${id}: a document sealed under another encryption key ` +
          'already occupies this id'
      );
    }
    const now = dayjs().toISOString();
    const doc = (existing && !existing.deletedAt
      ? {
          ...existing,
          ...rest,
          id,
          updatedAt: now,
          updatedBy: authorId,
        }
      : {
          ...rest,
          id,
          createdAt: now,
          updatedAt: now,
          createdBy: authorId,
          updatedBy: authorId,
          deletedAt: null,
          deletedBy: null,
        }) as unknown as T;
    const validated = this.validateDoc(collection, doc);
    await this.persist(collection, validated);
    await this.syncEngine.queuePush(collection, [validated.id]);
    this.emit(collection);
    return validated;
  }

  private async delete(collection: string, id: string): Promise<void> {
    this.assertDefined(collection);
    const authorId = await this.requireAuthor();
    const existing = this.migrateRead<BaseDocument>(
      collection,
      await this.adapter.get<BaseDocument>(collection, id)
    );
    if (!existing) throw new Error(`Document not found: ${collection}/${id}`);
    const now = dayjs().toISOString();
    const deleted = {
      ...existing,
      updatedAt: now,
      updatedBy: authorId,
      deletedAt: now,
      deletedBy: authorId,
    };
    await this.persist(collection, deleted);
    await this.syncEngine.queuePush(collection, [deleted.id]);
    this.emit(collection);
  }

  private async createMany<T extends BaseDocument>(
    collection: string,
    items: Array<Omit<T, keyof BaseDocument> & { id?: T['id'] }>
  ): Promise<T[]> {
    const authorId = await this.requireAuthor();
    const now = dayjs().toISOString();
    const docs = items.map(({ id, ...input }) => {
      const doc = {
        ...input,
        id: id ?? this.newId(collection),
        createdAt: now,
        updatedAt: now,
        createdBy: authorId,
        updatedBy: authorId,
        deletedAt: null,
        deletedBy: null,
      } as unknown as T;
      return this.validateDoc(collection, doc);
    });
    await Promise.all(docs.map((doc) => this.persist(collection, doc)));
    await this.syncEngine.queuePush(
      collection,
      docs.map((doc) => doc.id)
    );
    this.emit(collection);
    return docs;
  }

  private async updateMany<T extends BaseDocument>(
    collection: string,
    updates: Array<{ id: string } & Partial<Omit<T, keyof BaseDocument>>>
  ): Promise<T[]> {
    const authorId = await this.requireAuthor();
    const now = dayjs().toISOString();
    const docs: T[] = [];
    for (const { id, ...input } of updates) {
      const existing = this.migrateRead<T>(collection, await this.adapter.get<T>(collection, id));
      if (!existing) throw new Error(`Document not found: ${collection}/${id}`);
      const updated = this.validateDoc(collection, {
        ...existing,
        ...input,
        id,
        createdAt: existing.createdAt,
        updatedAt: now,
        createdBy: existing.createdBy,
        updatedBy: authorId,
      } as T);
      docs.push(updated);
    }
    await Promise.all(docs.map((doc) => this.persist(collection, doc)));
    await this.syncEngine.queuePush(
      collection,
      docs.map((doc) => doc.id)
    );
    this.emit(collection);
    return docs;
  }

  private async deleteMany(collection: string, ids: string[]): Promise<void> {
    this.assertDefined(collection);
    const authorId = await this.requireAuthor();
    const now = dayjs().toISOString();
    const deleted: BaseDocument[] = [];
    for (const id of ids) {
      const existing = this.migrateRead<BaseDocument>(
        collection,
        await this.adapter.get<BaseDocument>(collection, id)
      );
      if (!existing) throw new Error(`Document not found: ${collection}/${id}`);
      deleted.push({
        ...existing,
        updatedAt: now,
        updatedBy: authorId,
        deletedAt: now,
        deletedBy: authorId,
      });
    }
    await Promise.all(deleted.map((doc) => this.persist(collection, doc)));
    await this.syncEngine.queuePush(
      collection,
      deleted.map((doc) => doc.id)
    );
    this.emit(collection);
  }

  private async hardDelete(collection: string, id: string): Promise<void> {
    this.assertDefined(collection);
    await this.remove(collection, id);
    this.emit(collection);
  }

  private async hardDeleteMany(collection: string, ids: string[]): Promise<void> {
    this.assertDefined(collection);
    await Promise.all(ids.map((id) => this.remove(collection, id)));
    this.emit(collection);
  }

  private pullAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    this.assertDefined(collection);
    return this.syncEngine.pull<T>(collection);
  }

  private async resyncFromScratch(): Promise<void> {
    // Straight through the adapter rather than hardDeleteMany: this must also clear collections
    // the current build no longer defines. Indexes are dropped wholesale; the pulls repopulate
    // them through persist.
    this.indexes?.clear();
    const collections = await this.adapter.listCollections();
    for (const collection of collections) {
      if (collection === '_config') continue;
      // Raw enumeration so rows sealed under other keys are cleared too.
      const all = await this.rawAdapter.getAll<BaseDocument>(collection);
      if (all.length > 0) {
        await Promise.all(all.map((d) => this.adapter.delete(collection, d.id)));
        this.emit(collection);
      }
    }
    await this.syncEngine.pullRegisteredCollections();
  }

  private async createBackup(opts?: { blobs?: boolean }): Promise<Uint8Array> {
    const collections: Record<string, BaseDocument[]> = {};
    // `_*` collections (credentials, cursors, outbox) are device-specific and must not travel.
    for (const name of await this.adapter.listCollections()) {
      if (name.startsWith('_')) continue;
      const docs = await this.adapter.getAll<BaseDocument>(name);
      // Rows sealed under other keys must not vanish from a backup: archive their envelopes as-is
      // (restore writes them back raw, so they stay readable to whichever key sealed them).
      if (this.hideUndecryptable) {
        const readable = new Set(docs.map((doc) => doc.id));
        for (const raw of await this.rawAdapter.getAll<BaseDocument>(name)) {
          if (isEncryptedDoc(raw) && !readable.has(raw.id)) docs.push(raw);
        }
      }
      if (docs.length > 0) collections[name] = docs;
    }

    const includeBlobs = (opts?.blobs ?? true) && this.blobAdapter !== null;
    const blobs: BackupBlob[] = [];
    if (includeBlobs && this.blobAdapter) {
      for (const hash of await this.blobAdapter.list()) {
        const bytes = await this.blobAdapter.read(hash);
        if (!bytes) continue;
        const mimeType = (await this.blobAdapter.mimeType(hash)) ?? 'application/octet-stream';
        blobs.push({ hash, mimeType, bytes });
      }
    }

    return packBackup(
      { formatVersion: BACKUP_FORMAT_VERSION, createdAt: dayjs().toISOString(), collections },
      blobs
    );
  }

  private async restoreBackup(
    archive: Uint8Array,
    opts?: { mode?: RestoreMode }
  ): Promise<RestoreResult> {
    const mode = opts?.mode ?? 'merge';
    const { manifest, blobs } = unpackBackup(archive);
    const collectionsSkipped = Object.keys(manifest.collections).filter(
      (name) => !this.definitions.has(name)
    );
    const collections = Object.keys(manifest.collections).filter((name) =>
      this.definitions.has(name)
    );

    let docsWritten = 0;
    let docsSkipped = 0;
    for (const name of collections) {
      const incoming = manifest.collections[name];
      if (mode === 'replace') {
        // Raw enumeration so rows sealed under other keys are cleared too.
        const existing = await this.rawAdapter.getAll<BaseDocument>(name);
        await Promise.all(existing.map((d) => this.remove(name, d.id)));
      }
      const toWrite: BaseDocument[] = [];
      const sealed: BaseDocument[] = [];
      for (const doc of incoming) {
        if (mode === 'merge') {
          // Last-write-wins mirroring the pull path: ties go to the archive. `updatedAt` is
          // cleartext on envelopes, so the raw read compares correctly against a sealed local row.
          const local = await this.rawAdapter.get<BaseDocument>(name, doc.id);
          if (local && local.updatedAt > doc.updatedAt) {
            docsSkipped++;
            continue;
          }
        }
        // Envelopes from another key bypass persist (no migration, validation or indexing is
        // possible on ciphertext) and land raw.
        if (isEncryptedDoc(doc)) sealed.push(doc);
        else toWrite.push(doc);
      }
      if (toWrite.length > 0) await this.persistMany(name, toWrite);
      for (const doc of sealed) await this.rawAdapter.put(name, doc);
      if (toWrite.length + sealed.length > 0) {
        docsWritten += toWrite.length + sealed.length;
        this.emit(name);
      }
    }

    let blobsWritten = 0;
    let blobsSkipped = 0;
    if (blobs.length > 0) {
      if (!this.blobAdapter) {
        blobsSkipped = blobs.length;
      } else {
        if (mode === 'replace') {
          for (const hash of await this.blobAdapter.list()) await this.blobAdapter.delete(hash);
        }
        for (const blob of blobs) {
          if (mode === 'merge' && (await this.blobAdapter.has(blob.hash))) continue;
          await this.blobAdapter.write(blob.hash, blob.bytes, blob.mimeType);
          blobsWritten++;
        }
        if (blobsWritten > 0) this.notifyBlobsChanged();
      }
    }

    return {
      mode,
      collections,
      collectionsSkipped,
      docsWritten,
      docsSkipped,
      blobsWritten,
      blobsSkipped,
    };
  }

  private pull<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    this.assertDefined(collection);
    return this.syncEngine.pullDocument<T>(collection, id);
  }

  private async listByIndex<T extends BaseDocument>(
    collection: string,
    index: string,
    key: IndexKeyInput
  ): Promise<T[]> {
    this.assertDefined(collection);
    if (!this.indexes?.has(collection, index)) {
      throw new Error(`Unknown index "${index}" on collection "${collection}"`);
    }
    // getMany keeps results migrated, validated and tombstone-free even if the index lags a write.
    const ids = this.indexes.find(collection, index, normalizeKey(key));
    return ids.length > 0 ? this.getMany<T>(collection, ids) : [];
  }

  /**
   * Typed handle to one defined collection. The document type is inferred from the collection's
   * schema; pass it explicitly (`store.collection<Doc>('name')`) when the definition list isn't
   * statically known.
   */
  collection<Name extends CollectionName<Defs>>(
    name: Name
  ): Collection<DocumentOf<Defs, Name>, CollectionIndexNames<Defs, Name>>;
  collection<T extends BaseDocument>(name: string): Collection<T>;
  collection<T extends BaseDocument>(name: string): Collection<T> {
    this.assertDefined(name);
    return {
      get: (id, opts) => this.get<T>(name, id, opts),
      getMany: (ids) => this.getMany<T>(name, ids),
      list: (opts) => this.list<T>(name, opts),
      listByIndex: (index, key) => this.listByIndex<T>(name, index, key),
      create: (input) => this.create<T>(name, input),
      createMany: (items) => this.createMany<T>(name, items),
      createAsSystem: (input) => this.createAsSystem<T>(name, input),
      update: (id, input) => this.update<T>(name, id, input),
      updateMany: (updates) => this.updateMany<T>(name, updates),
      upsert: (input) => this.upsert<T>(name, input),
      delete: (id) => this.delete(name, id),
      deleteMany: (ids) => this.deleteMany(name, ids),
      hardDelete: (id) => this.hardDelete(name, id),
      hardDeleteMany: (ids) => this.hardDeleteMany(name, ids),
      pull: (id) => this.pull<T>(name, id),
      pullAll: () => this.pullAll<T>(name),
    };
  }
}
