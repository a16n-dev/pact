import type { Text as YText } from 'yjs';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';
import { BlobSync } from '../blobs/blobSync';
import type { AnyDocument, BaseDocument } from '../types';
import { encryptedCodec, plainCodec, type RecordCodec } from '../crypto/codec';
import type { DocCipher } from '../crypto/types';
import { Migrator } from '../migrator';
import { randomId } from '../lib/ids';
import { ClockDriftError, HybridClock, clockToIso } from '../clock';
import {
  assertKeyLength,
  type CollectionDefinition,
  type CollectionIndexNames,
  type CollectionName,
  type CollectionIdKind,
  type CollectionTextFields,
  type DocumentInputOf,
  type DocumentOf,
} from '../collection';
import {
  greatestClock,
  isSealedRecord,
  mergeRecords,
  type StoredEntry,
  type StoredRecord,
} from '../record';
import { compareClocks } from '../clock';
import { IndexManager, normalizeKey, type IndexKeyInput } from './indexes';
import {
  BACKUP_FORMAT_VERSION,
  packBackup,
  unpackBackup,
  type BackupBlob,
  type BackupEntry,
} from '../backup/archive';
import type { Collection } from './collectionRef';
import type { ChangeHandler, StoreOptions } from './options';
import type {
  RestoreMode,
  RestoreResult,
  StoreBackup,
  StoreBlobs,
  StoreAi,
  StoreEncryption,
  StoreSync,
} from './namespaces';
import { SyncEngine, type ApplyResult, type HeldEntry } from '../sync/engine';
import {
  CONFIG,
  HELD,
  MAX_DOCUMENT_BYTES,
  OUTBOX,
  TEXT_PUSH_DEBOUNCE_MS,
  configRecord,
  outboxKey,
  type EncryptionConfig,
  type NodeConfig,
  type OutboxEntry,
} from './internal';
import {
  migrateRecord,
  needsMigration,
  parseProjection,
  projectRecord,
  validateProjection,
} from './records';
import { TextCache } from './textCache';
import { createAi } from '../ai/ai';
import type { TextDocument } from '../text/engine';

// Any constant works: a wrong key fails to open the sealed check regardless of content.
const KEYCHECK_SENTINEL = 'pact-keycheck';
const KEYCHECK_AAD = '_config/encryption';

const encoder = new TextEncoder();

export class Store<Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[]> {
  private readonly adapter: DatabaseAdapter;
  private readonly codec: RecordCodec;
  private readonly cipher: DocCipher | null;
  private readonly definitions: ReadonlyMap<string, CollectionDefinition>;
  private readonly definitionsByKey: ReadonlyMap<string, CollectionDefinition>;
  private readonly migrator: Migrator;
  private readonly indexes: IndexManager | null;
  private readonly textCache = new TextCache();
  private readonly clock: HybridClock;
  // Writes and merges to one document run one at a time, in arrival order.
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly signedOutHandlers = new Set<() => void>();
  private readonly syncEngine: SyncEngine;
  private readonly blobAdapter: BlobAdapter | null;
  // Without an extractor blob GC cannot tell referenced from orphan and must refuse to run.
  private readonly blobHashesOf: (collection: string, doc: BaseDocument) => Iterable<string>;
  private readonly hasBlobRefs: boolean;

  readonly sync: StoreSync;
  readonly backup: StoreBackup;
  readonly blobs: StoreBlobs;
  readonly encryption: StoreEncryption;
  readonly ai: StoreAi;

  private constructor(options: StoreOptions<Defs>, node: string) {
    this.adapter = options.adapter;
    this.cipher = options.encryption?.cipher ?? null;
    this.codec = this.cipher ? encryptedCodec(this.cipher) : plainCodec();
    this.blobAdapter = options.blobs ?? null;
    const defs = options.collections;
    this.definitions = new Map(defs.map((d) => [d.name, d]));
    if (this.definitions.size !== defs.length) {
      throw new Error('Duplicate collection name in StoreOptions.collections');
    }
    for (const def of defs) {
      if (def.name.startsWith('_')) {
        throw new Error(`Collection name "${def.name}" is reserved (the _* namespace is internal)`);
      }
    }
    this.definitionsByKey = new Map(defs.map((d) => [d.key, d]));
    if (this.definitionsByKey.size !== defs.length) {
      throw new Error('Duplicate collection key in StoreOptions.collections');
    }
    const registry: Record<string, NonNullable<CollectionDefinition['migrations']>> = {};
    for (const def of defs) if (def.migrations) registry[def.name] = def.migrations;
    this.migrator = new Migrator(registry);
    const indexManager = new IndexManager(defs);
    this.indexes = indexManager.isEmpty ? null : indexManager;
    this.clock = new HybridClock(node);
    this.hasBlobRefs = options.blobHashes !== undefined;
    this.blobHashesOf = options.blobHashes ?? (() => []);
    this.syncEngine = new SyncEngine({
      adapter: this.adapter,
      codec: this.codec,
      clock: this.clock,
      node,
      syncedDefinitions: defs.filter((d) => d.synced),
      definitionByKey: (key) => this.definitionsByKey.get(key),
      definitionByName: (name) => this.definitions.get(name),
      applyIncoming: (def, id, record) => this.applyIncoming(def, id, record),
      heldEntries: () => this.heldEntries(),
      clearLocalData: () => this.clearLocalData(),
      emit: (collection) => this.emit(collection),
      emitSignedOut: () => {
        for (const handler of this.signedOutHandlers) handler();
      },
    });

    this.sync = {
      beginSignIn: (start) => this.syncEngine.beginSignIn(start),
      completeSignIn: (input) => this.syncEngine.completeSignIn(input),
      signOut: () => this.syncEngine.signOut(),
      session: () => this.syncEngine.session(),
      registration: () => this.syncEngine.registration(),
      credentials: () => this.syncEngine.credentials(),
      pull: () => this.syncEngine.pull(),
      pullDocument: (collection, id) => this.syncEngine.pullDocument(collection, id),
      drain: () => this.syncEngine.drain(),
      push: () => this.syncEngine.push(),
      pending: () => this.syncEngine.pending(),
      resync: () => this.syncEngine.resync(),
      lastSyncedAt: () => this.syncEngine.lastSyncedAt(),
    };

    this.backup = {
      create: (opts) => this.createBackup(opts),
      restore: (archive, opts) => this.restoreBackup(archive, opts),
    };
    const blobSync = this.blobAdapter
      ? new BlobSync({
          adapter: this.blobAdapter,
          credentials: () => this.syncEngine.credentials(),
          notifyChanged: () => this.notifyBlobsChanged(),
          onUnauthorized: () => void this.syncEngine.handleSignedOut(),
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
    this.ai = createAi({
      credentials: () => this.syncEngine.credentials(),
      onUnauthorized: () => void this.syncEngine.handleSignedOut(),
    });
  }

  static async create<Defs extends readonly CollectionDefinition[]>(
    options: StoreOptions<Defs>
  ): Promise<Store<Defs>> {
    const store = new Store(options, await Store.loadNode(options.adapter));
    await store.verifyEncryptionKey();
    await store.retryHeld();
    await store.buildIndexes();
    await store.syncEngine.restore();
    // Network work never blocks startup; `signedOut` fires if the token is gone.
    void store.syncEngine.start().catch(() => {});
    return store;
  }

  // The install id: the HLC node and, later, the OAuth device id.
  private static async loadNode(adapter: DatabaseAdapter): Promise<string> {
    const existing = await adapter.get(CONFIG, 'node');
    if (existing && !isSealedRecord(existing)) return (existing.fields as NodeConfig).node;
    const node = randomId(12);
    await adapter.put(CONFIG, 'node', configRecord('node', { node }));
    return node;
  }

  on(event: 'change', handler: ChangeHandler): () => void;
  on(event: 'signedOut', handler: () => void): () => void;
  on(event: 'change' | 'signedOut', handler: ChangeHandler | (() => void)): () => void {
    if (event === 'signedOut') {
      const h = handler as () => void;
      this.signedOutHandlers.add(h);
      return () => this.signedOutHandlers.delete(h);
    }
    this.changeHandlers.add(handler as ChangeHandler);
    return () => this.changeHandlers.delete(handler as ChangeHandler);
  }

  /**
   * Closes realtime and releases live text documents. Document reads,
   * writes and explicit sync calls keep working afterwards.
   */
  dispose(): void {
    this.syncEngine.stop();
    this.textCache.clear();
  }

  private emit(collection: string): void {
    for (const handler of this.changeHandlers) handler(collection);
  }

  // Blob changes ride the document change channel so UI invalidation needs one subscription.
  private notifyBlobsChanged(): void {
    this.emit('_blobs');
  }

  private async getConfig<T extends Record<string, unknown>>(id: string): Promise<T | null> {
    const raw = await this.adapter.get(CONFIG, id);
    if (!raw || isSealedRecord(raw)) return null;
    const { id: _id, createdAt: _createdAt, ...value } = raw.fields;
    return value as T;
  }

  private async setConfig(id: string, value: Record<string, unknown>): Promise<void> {
    await this.adapter.put(CONFIG, id, configRecord(id, value));
  }

  private def(name: string): CollectionDefinition {
    const def = this.definitions.get(name);
    if (!def) {
      throw new Error(
        `Unknown collection "${name}": every collection must be defined ` +
          '(with its schema) in StoreOptions.collections'
      );
    }
    return def;
  }

  private serialise<T>(collection: string, id: string, task: () => Promise<T>): Promise<T> {
    const key = `${collection}/${id}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  private async loadRaw(def: CollectionDefinition, id: string): Promise<StoredRecord | null> {
    const stored = await this.adapter.get(def.key, id);
    return stored ? this.codec.decode(def.key, id, stored) : null;
  }

  /**
   * The record at the current schema version, with the live text state when
   * the document is open. Null when missing, or when a stored record is
   * newer than this build (an app downgrade) and so cannot be read.
   */
  private async materialise(
    def: CollectionDefinition,
    id: string,
    raw: StoredRecord
  ): Promise<StoredRecord | null> {
    if (raw.schemaVersion > this.migrator.currentVersion(def.name)) return null;
    let record = raw;
    if (needsMigration(this.migrator, def, raw)) {
      record = migrateRecord(this.migrator, def, raw);
      // Lazy write-back under the document lock so it cannot clobber a concurrent write.
      void this.serialise(def.name, id, async () => {
        const current = await this.loadRaw(def, id);
        if (current && needsMigration(this.migrator, def, current)) {
          await this.putRecord(def, id, migrateRecord(this.migrator, def, current));
        }
      }).catch(() => {});
    }
    const text = this.textCache.get(def.name, id);
    if (text) record = { ...record, text: text.encode() };
    return record;
  }

  private async loadRecord(def: CollectionDefinition, id: string): Promise<StoredRecord | null> {
    const raw = await this.loadRaw(def, id);
    return raw ? this.materialise(def, id, raw) : null;
  }

  private async putRecord(
    def: CollectionDefinition,
    id: string,
    record: StoredRecord
  ): Promise<void> {
    const encoded = await this.codec.encode(def.key, id, record);
    const bytes = encoder.encode(this.codec.toWire(encoded)).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new Error(`Document ${def.name}/${id} is ${bytes} bytes; the limit is 1 MB`);
    }
    await this.adapter.put(def.key, id, encoded);
    this.indexWrite(def, id, record);
  }

  private openText(def: CollectionDefinition, id: string, state: string | undefined): TextDocument {
    const existing = this.textCache.get(def.name, id);
    if (existing) return existing;
    const doc = this.textCache.open(def, id, state);
    doc.onLocalChange((fields) => this.onTextEdited(def, id, fields));
    return doc;
  }

  // Projects and validates; a record that fails its schema reads as missing.
  private readDoc(def: CollectionDefinition, id: string, record: StoredRecord): AnyDocument | null {
    const text = def.textEngine ? this.openText(def, id, record.text) : null;
    return validateProjection(def, projectRecord(def, record, text));
  }

  private indexWrite(def: CollectionDefinition, id: string, record: StoredRecord): void {
    if (!this.indexes?.hasIndexesFor(def.name)) return;
    const doc = this.readDoc(def, id, record);
    if (doc) this.indexes.onPersist(def.name, doc);
    else this.indexes.onRemove(def.name, id);
  }

  private async buildIndexes(): Promise<void> {
    if (!this.indexes) return;
    this.indexes.clear();
    for (const name of this.indexes.indexedCollections()) {
      const def = this.def(name);
      for (const { id, raw } of await this.allRecords(def)) {
        const record = await this.materialise(def, id, raw);
        if (record) this.indexWrite(def, id, record);
      }
    }
  }

  private async allRecords(
    def: CollectionDefinition
  ): Promise<Array<{ id: string; raw: StoredRecord }>> {
    const entries = await this.adapter.getAll(def.key);
    return Promise.all(
      entries.map(async ({ id, record }) => ({
        id,
        raw: await this.codec.decode(def.key, id, record),
      }))
    );
  }

  private stamp(
    def: CollectionDefinition,
    record: StoredRecord,
    fields: Iterable<string>,
    clock: string
  ): void {
    if (def.merge === 'document') {
      record.clock = clock;
      delete record.clocks;
      return;
    }
    record.clocks = { ...record.clocks };
    for (const field of fields) {
      if (field === 'id' || field === 'createdAt') continue;
      record.clocks[field] = clock;
    }
  }

  // Stored fields are plain JSON: the schema may output `Date`s, which would
  // otherwise compare unequal to the ISO strings a pull brings back.
  private fieldsFrom(def: CollectionDefinition, doc: AnyDocument): Record<string, unknown> {
    const { updatedAt: _updatedAt, ...rest } = doc;
    for (const field of def.textFields) delete rest[field];
    return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  }

  private splitInput(
    def: CollectionDefinition,
    input: Record<string, unknown>
  ): { plain: Record<string, unknown>; text: Record<string, string> } {
    const plain: Record<string, unknown> = {};
    const text: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (def.textFields.includes(key)) {
        if (typeof value !== 'string') throw new Error(`Text field "${key}" takes a string`);
        text[key] = value;
      } else plain[key] = value;
    }
    return { plain, text };
  }

  private async queueOutbox(
    def: CollectionDefinition,
    id: string,
    clock: string,
    debounceMs?: number
  ): Promise<void> {
    if (!def.synced) return;
    const key = outboxKey(def.key, id);
    const entry: OutboxEntry = { collection: def.name, docId: id, order: clock };
    await this.adapter.put(OUTBOX, key, configRecord(key, entry));
    this.emit(OUTBOX);
    this.syncEngine.requestDrain(
      debounceMs === undefined ? undefined : { key, delayMs: debounceMs }
    );
  }

  private async insert(
    def: CollectionDefinition,
    id: string,
    input: Record<string, unknown>,
    existing: StoredRecord | null
  ): Promise<AnyDocument> {
    assertKeyLength('Document id', id);
    const clock = this.clock.now();
    const now = clockToIso(clock);
    const { plain, text } = this.splitInput(def, input);
    const createdAt = (existing?.fields.createdAt as string | undefined) ?? now;
    const parsed = parseProjection(def, {
      ...plain,
      ...text,
      id,
      createdAt,
      updatedAt: now,
      deletedAt: null,
    } as AnyDocument);
    const record: StoredRecord = {
      schemaVersion: this.migrator.currentVersion(def.name),
      fields: this.fieldsFrom(def, parsed),
    };
    if (def.textEngine) {
      const doc = this.openText(def, id, existing?.text);
      for (const field of def.textFields) doc.replace(field, parsed[field] as string);
      record.text = doc.encode();
    }
    // Reviving a tombstone drops its old fields, so those are stamped too.
    const stamped = new Set([
      ...Object.keys(record.fields),
      ...def.textFields,
      ...Object.keys(existing?.fields ?? {}),
    ]);
    this.stamp(def, record, stamped, clock);
    await this.putRecord(def, id, record);
    await this.queueOutbox(def, id, clock);
    return this.readDoc(def, id, record)!;
  }

  private async modify(
    def: CollectionDefinition,
    id: string,
    existing: StoredRecord,
    input: Record<string, unknown>,
    tombstone: boolean
  ): Promise<AnyDocument> {
    const clock = this.clock.now();
    const now = clockToIso(clock);
    const { plain, text } = this.splitInput(def, input);
    const doc = def.textEngine ? this.openText(def, id, existing.text) : null;
    const current = projectRecord(def, existing, doc);
    const parsed = parseProjection(def, {
      ...current,
      ...plain,
      ...text,
      id,
      createdAt: current.createdAt,
      updatedAt: now,
      deletedAt: tombstone ? now : current.deletedAt,
    } as AnyDocument);
    const record: StoredRecord = { ...existing, fields: this.fieldsFrom(def, parsed) };
    if (doc) {
      for (const field of Object.keys(text)) doc.replace(field, parsed[field] as string);
      record.text = doc.encode();
    }
    const stamped = [
      ...Object.keys(plain),
      ...Object.keys(text),
      ...(tombstone ? ['deletedAt'] : []),
    ];
    this.stamp(def, record, stamped, clock);
    await this.putRecord(def, id, record);
    await this.queueOutbox(def, id, clock);
    return this.readDoc(def, id, record)!;
  }

  private onTextEdited(def: CollectionDefinition, id: string, fields: readonly string[]): void {
    void this.serialise(def.name, id, async () => {
      const existing = await this.loadRecord(def, id);
      const doc = this.textCache.get(def.name, id);
      if (!existing || !doc) return;
      const clock = this.clock.now();
      const record: StoredRecord = { ...existing, text: doc.encode() };
      this.stamp(def, record, fields, clock);
      await this.putRecord(def, id, record);
      await this.queueOutbox(def, id, clock, TEXT_PUSH_DEBOUNCE_MS);
      this.emit(def.name);
      // Nothing can be reported to the editor; the next write surfaces a persistent fault.
    }).catch(() => {});
  }

  private idFor(def: CollectionDefinition, id: string | undefined): string {
    if (id !== undefined) return id;
    if (def.ids === 'slug') {
      throw new Error(`Collection "${def.name}" uses slug ids: pass an id to create`);
    }
    return def.generateId();
  }

  private async create(
    def: CollectionDefinition,
    input: Record<string, unknown>
  ): Promise<AnyDocument> {
    const { id: given, ...rest } = input as { id?: string };
    const id = this.idFor(def, given);
    return this.serialise(def.name, id, async () => {
      if (await this.adapter.get(def.key, id)) {
        throw new Error(`Document already exists: ${def.name}/${id}`);
      }
      const doc = await this.insert(def, id, rest, null);
      this.emit(def.name);
      return doc;
    });
  }

  private async update(
    def: CollectionDefinition,
    id: string,
    input: Record<string, unknown>
  ): Promise<AnyDocument> {
    return this.serialise(def.name, id, async () => {
      const existing = await this.loadRecord(def, id);
      if (!existing) throw new Error(`Document not found: ${def.name}/${id}`);
      const doc = await this.modify(def, id, existing, input, false);
      this.emit(def.name);
      return doc;
    });
  }

  private async upsert(
    def: CollectionDefinition,
    input: Record<string, unknown>
  ): Promise<AnyDocument> {
    const { id, ...rest } = input as { id: string };
    return this.serialise(def.name, id, async () => {
      const existing = await this.loadRecord(def, id);
      const doc =
        existing && !existing.fields.deletedAt
          ? await this.modify(def, id, existing, rest, false)
          : await this.insert(def, id, rest, existing);
      this.emit(def.name);
      return doc;
    });
  }

  private async getOrCreate(
    def: CollectionDefinition,
    input: Record<string, unknown>
  ): Promise<AnyDocument> {
    const { id, ...rest } = input as { id: string };
    return this.serialise(def.name, id, async () => {
      const existing = await this.loadRecord(def, id);
      const live = existing && !existing.fields.deletedAt ? this.readDoc(def, id, existing) : null;
      if (live) return live;
      const doc = await this.insert(def, id, rest, existing);
      this.emit(def.name);
      return doc;
    });
  }

  private async delete(def: CollectionDefinition, id: string): Promise<void> {
    await this.serialise(def.name, id, async () => {
      const existing = await this.loadRecord(def, id);
      if (!existing) throw new Error(`Document not found: ${def.name}/${id}`);
      await this.modify(def, id, existing, {}, true);
    });
    this.emit(def.name);
  }

  private async createMany(
    def: CollectionDefinition,
    items: Array<Record<string, unknown>>
  ): Promise<AnyDocument[]> {
    const docs: AnyDocument[] = [];
    for (const item of items) {
      const { id: given, ...rest } = item as { id?: string };
      const id = this.idFor(def, given);
      docs.push(
        await this.serialise(def.name, id, async () => {
          if (await this.adapter.get(def.key, id)) {
            throw new Error(`Document already exists: ${def.name}/${id}`);
          }
          return this.insert(def, id, rest, null);
        })
      );
    }
    if (docs.length > 0) this.emit(def.name);
    return docs;
  }

  private async updateMany(
    def: CollectionDefinition,
    updates: Array<{ id: string } & Record<string, unknown>>
  ): Promise<AnyDocument[]> {
    const docs: AnyDocument[] = [];
    for (const { id, ...input } of updates) {
      docs.push(
        await this.serialise(def.name, id, async () => {
          const existing = await this.loadRecord(def, id);
          if (!existing) throw new Error(`Document not found: ${def.name}/${id}`);
          return this.modify(def, id, existing, input, false);
        })
      );
    }
    if (docs.length > 0) this.emit(def.name);
    return docs;
  }

  private async deleteMany(def: CollectionDefinition, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.serialise(def.name, id, async () => {
        const existing = await this.loadRecord(def, id);
        if (!existing) throw new Error(`Document not found: ${def.name}/${id}`);
        await this.modify(def, id, existing, {}, true);
      });
    }
    if (ids.length > 0) this.emit(def.name);
  }

  private async text(def: CollectionDefinition, id: string, field: string): Promise<YText> {
    if (!def.textEngine || !def.textFields.includes(field)) {
      throw new Error(`"${field}" is not a text field of ${def.name}`);
    }
    const record = await this.loadRecord(def, id);
    if (!record) throw new Error(`Document not found: ${def.name}/${id}`);
    return this.openText(def, id, record.text).handle(field) as YText;
  }

  private async get(
    def: CollectionDefinition,
    id: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<AnyDocument | null> {
    this.syncEngine.triggerReadPull();
    const record = await this.loadRecord(def, id);
    const doc = record ? this.readDoc(def, id, record) : null;
    if (!doc) return null;
    return doc.deletedAt && !opts?.includeDeleted ? null : doc;
  }

  private async getMany(def: CollectionDefinition, ids: readonly string[]): Promise<AnyDocument[]> {
    this.syncEngine.triggerReadPull();
    const entries = await this.adapter.getMany(def.key, ids);
    const byId = new Map<string, AnyDocument>();
    for (const entry of entries) {
      const doc = await this.docFromEntry(def, entry);
      if (doc && !doc.deletedAt) byId.set(entry.id, doc);
    }
    return ids.map((id) => byId.get(id)).filter((doc): doc is AnyDocument => doc !== undefined);
  }

  private async list(
    def: CollectionDefinition,
    opts?: { includeDeleted?: boolean }
  ): Promise<AnyDocument[]> {
    this.syncEngine.triggerReadPull();
    const docs: AnyDocument[] = [];
    for (const entry of await this.adapter.getAll(def.key)) {
      const doc = await this.docFromEntry(def, entry);
      if (doc && (opts?.includeDeleted || !doc.deletedAt)) docs.push(doc);
    }
    return docs;
  }

  private async docFromEntry(
    def: CollectionDefinition,
    entry: StoredEntry
  ): Promise<AnyDocument | null> {
    const raw = await this.codec.decode(def.key, entry.id, entry.record);
    const record = await this.materialise(def, entry.id, raw);
    return record ? this.readDoc(def, entry.id, record) : null;
  }

  private async listByIndex(
    def: CollectionDefinition,
    index: string,
    key: IndexKeyInput
  ): Promise<AnyDocument[]> {
    if (!this.indexes?.has(def.name, index)) {
      throw new Error(`Unknown index "${index}" on collection "${def.name}"`);
    }
    // getMany keeps results migrated, validated and tombstone-free even if the index lags a write.
    const ids = this.indexes.find(def.name, index, normalizeKey(key));
    return ids.length > 0 ? this.getMany(def, ids) : [];
  }

  /**
   * Merges a version from another writer, or an archive, into the local
   * record. Held versions wait in `_held` until a build can migrate and
   * validate them; the caller has already checked the clock for drift.
   */
  private applyIncoming(
    def: CollectionDefinition,
    id: string,
    incoming: StoredRecord
  ): Promise<ApplyResult> {
    return this.serialise(def.name, id, async () => {
      const current = this.migrator.currentVersion(def.name);
      if (incoming.schemaVersion > current) return this.hold(def, id, incoming);
      const migrated =
        incoming.schemaVersion < current
          ? migrateRecord(this.migrator, def, incoming)
          : { ...incoming };
      if (!this.validateIncoming(def, migrated)) return this.hold(def, id, incoming);
      const local = await this.loadRecord(def, id);
      if (!local) {
        if (def.textEngine) migrated.text = this.openText(def, id, migrated.text).encode();
        await this.putRecord(def, id, migrated);
        return 'applied';
      }
      const mergeText = def.textEngine
        ? (mine: string | undefined, theirs: string | undefined) => {
            const doc = this.openText(def, id, mine);
            if (theirs !== undefined) doc.merge(theirs);
            return doc.encode();
          }
        : undefined;
      const { record, changed } = mergeRecords(local, migrated, def.merge, mergeText);
      if (!changed) return 'unchanged';
      await this.putRecord(def, id, record);
      return 'applied';
    });
  }

  private validateIncoming(def: CollectionDefinition, record: StoredRecord): boolean {
    if (record.fields.id === undefined || typeof record.fields.createdAt !== 'string') return false;
    const text = def.textEngine ? def.textEngine.open(def.textFields, record.text) : null;
    try {
      return validateProjection(def, projectRecord(def, record, text)) !== null;
    } finally {
      text?.destroy();
    }
  }

  private async hold(
    def: CollectionDefinition,
    id: string,
    incoming: StoredRecord
  ): Promise<ApplyResult> {
    const key = outboxKey(def.key, id);
    const existing = await this.getConfigFrom<HeldEntry>(HELD, key);
    if (existing) {
      const held = await this.codec.decode(def.key, id, existing.data);
      const mine = greatestClock(held);
      const theirs = greatestClock(incoming);
      if (mine !== undefined && theirs !== undefined && compareClocks(mine, theirs) >= 0)
        return 'held';
    }
    const data = await this.codec.encode(def.key, id, incoming);
    const entry: HeldEntry = { collection: def.key, docId: id, data };
    await this.adapter.put(HELD, key, configRecord(key, entry));
    return 'held';
  }

  private async getConfigFrom<T extends Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<T | null> {
    const raw = await this.adapter.get(collection, id);
    if (!raw || isSealedRecord(raw)) return null;
    const { id: _id, createdAt: _createdAt, ...value } = raw.fields;
    return value as T;
  }

  private async heldEntries(): Promise<HeldEntry[]> {
    const rows = await this.adapter.getAll(HELD);
    return rows.flatMap(({ record }) =>
      isSealedRecord(record) ? [] : [record.fields as unknown as HeldEntry]
    );
  }

  // Straight through the adapter so collections this build no longer defines
  // are cleared too; the pull that follows repopulates indexes through putRecord.
  private async clearLocalData(): Promise<void> {
    for (const collection of await this.adapter.listCollections()) {
      if (collection === CONFIG) continue;
      for (const { id } of await this.adapter.getAll(collection)) {
        await this.adapter.delete(collection, id);
      }
    }
    this.indexes?.clear();
    this.textCache.clear();
    for (const name of this.definitions.keys()) this.emit(name);
  }

  private async retryHeld(): Promise<void> {
    const touched = new Set<string>();
    for (const { id: key, record } of await this.adapter.getAll(HELD)) {
      if (isSealedRecord(record)) continue;
      const entry = record.fields as unknown as HeldEntry;
      const def = this.definitionsByKey.get(entry.collection);
      if (!def) continue;
      const incoming = await this.codec.decode(def.key, entry.docId, entry.data);
      if ((await this.applyIncoming(def, entry.docId, incoming)) === 'held') continue;
      await this.adapter.delete(HELD, key);
      touched.add(def.name);
    }
    for (const name of touched) this.emit(name);
  }

  private async verifyEncryptionKey(): Promise<void> {
    if (!this.cipher) return;
    const existing = await this.getConfig<EncryptionConfig>('encryption');
    if (!existing) {
      const check = await this.cipher.seal(encoder.encode(KEYCHECK_SENTINEL), KEYCHECK_AAD);
      await this.setConfig('encryption', { check });
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

  private async encryptLocalData(): Promise<{ rewritten: number }> {
    if (!this.cipher) throw new Error('encryptLocal requires the encryption option');
    let rewritten = 0;
    for (const def of this.definitions.values()) {
      for (const { id, record } of await this.adapter.getAll(def.key)) {
        if (isSealedRecord(record)) continue;
        await this.adapter.put(def.key, id, await this.codec.encode(def.key, id, record));
        rewritten += 1;
      }
    }
    for (const { id: key, record } of await this.adapter.getAll(HELD)) {
      if (isSealedRecord(record)) continue;
      const entry = record.fields as unknown as HeldEntry;
      if (isSealedRecord(entry.data)) continue;
      const data = await this.codec.encode(entry.collection, entry.docId, entry.data);
      await this.adapter.put(HELD, key, configRecord(key, { ...entry, data }));
      rewritten += 1;
    }
    return { rewritten };
  }

  private async referencedBlobHashes(): Promise<Set<string>> {
    const refs = new Set<string>();
    if (!this.hasBlobRefs) return refs;
    for (const def of this.definitions.values()) {
      for (const doc of await this.list(def)) {
        for (const hash of this.blobHashesOf(def.name, doc)) refs.add(hash);
      }
    }
    return refs;
  }

  // Local-only by design: deleting a shared, content-addressed blob server-side would break any
  // other device still referencing it, and there is no safe moment to know every client has
  // dropped the reference. A pruned blob re-pulls if a referencing document arrives later.
  private async pruneBlobs(): Promise<{ deleted: string[] }> {
    if (!this.blobAdapter) return { deleted: [] };
    if (!this.hasBlobRefs) {
      throw new Error(
        'blobs.prune requires a StoreOptions.blobHashes extractor; refusing to treat every blob as an orphan'
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

  private async createBackup(opts?: { blobs?: boolean }): Promise<Uint8Array> {
    const collections: Record<string, BackupEntry[]> = {};
    for (const def of this.definitions.values()) {
      const entries = await this.allRecords(def);
      if (entries.length > 0)
        collections[def.name] = entries.map(({ id, raw }) => ({ id, record: raw }));
    }
    const blobs: BackupBlob[] = [];
    if ((opts?.blobs ?? true) && this.blobAdapter) {
      for (const hash of await this.blobAdapter.list()) {
        const bytes = await this.blobAdapter.read(hash);
        if (!bytes) continue;
        const mimeType = (await this.blobAdapter.mimeType(hash)) ?? 'application/octet-stream';
        blobs.push({ hash, mimeType, bytes });
      }
    }
    return packBackup(
      { formatVersion: BACKUP_FORMAT_VERSION, createdAt: new Date().toISOString(), collections },
      blobs
    );
  }

  private async restoreBackup(
    archive: Uint8Array,
    opts?: { mode?: RestoreMode }
  ): Promise<RestoreResult> {
    const mode = opts?.mode ?? 'merge';
    const { manifest, blobs } = unpackBackup(archive);
    const names = Object.keys(manifest.collections);
    const collections = names.filter((name) => this.definitions.has(name));
    const collectionsSkipped = names.filter((name) => !this.definitions.has(name));

    let docsWritten = 0;
    let docsSkipped = 0;
    for (const name of collections) {
      const def = this.def(name);
      const incoming = manifest.collections[name] ?? [];
      let written = 0;
      if (mode === 'replace') {
        for (const { id } of await this.adapter.getAll(def.key)) {
          await this.adapter.delete(def.key, id);
          this.indexes?.onRemove(def.name, id);
          this.textCache.drop(def.name, id);
        }
      }
      for (const { id, record } of incoming) {
        const clock = greatestClock(record);
        let drifted = false;
        if (clock !== undefined) {
          try {
            this.clock.receive(clock);
          } catch (err) {
            if (!(err instanceof ClockDriftError)) throw err;
            drifted = true;
          }
        }
        if (mode === 'replace') {
          await this.serialise(def.name, id, () => this.putRecord(def, id, record));
          written += 1;
          continue;
        }
        if (drifted || (await this.applyIncoming(def, id, record)) !== 'applied') docsSkipped += 1;
        else written += 1;
      }
      docsWritten += written;
      if (written > 0 || mode === 'replace') this.emit(name);
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

  /**
   * Typed handle to one defined collection. The document type is inferred from the collection's
   * schema; pass it explicitly (`store.collection<Doc>('name')`) when the definition list isn't
   * statically known.
   */
  collection<Name extends CollectionName<Defs>>(
    name: Name
  ): Collection<
    DocumentOf<Defs, Name>,
    CollectionIndexNames<Defs, Name>,
    CollectionTextFields<Defs, Name>,
    DocumentInputOf<Defs, Name>,
    CollectionIdKind<Defs, Name>
  >;
  collection<T extends BaseDocument>(name: string): Collection<T>;
  collection<T extends BaseDocument>(name: string): Collection<T> {
    const def = this.def(name);
    type Input = Record<string, unknown>;
    return {
      get: (id, opts) => this.get(def, id, opts) as Promise<T | null>,
      getMany: (ids) => this.getMany(def, ids) as Promise<T[]>,
      list: (opts) => this.list(def, opts) as Promise<T[]>,
      listByIndex: (index, key) => this.listByIndex(def, index, key) as Promise<T[]>,
      create: (input) => this.create(def, input as Input) as Promise<T>,
      createMany: (items) => this.createMany(def, items as Input[]) as Promise<T[]>,
      update: (id, input) => this.update(def, id, input as Input) as Promise<T>,
      updateMany: (updates) =>
        this.updateMany(def, updates as Array<{ id: string } & Input>) as Promise<T[]>,
      upsert: (input) => this.upsert(def, input as Input) as Promise<T>,
      getOrCreate: (input) => this.getOrCreate(def, input as Input) as Promise<T>,
      delete: (id) => this.delete(def, id),
      deleteMany: (ids) => this.deleteMany(def, ids),
      text: (id, field) => this.text(def, id, field),
    };
  }
}
