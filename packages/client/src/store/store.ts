import type { Text as YText } from 'yjs';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';
import { BlobSync } from '../blobs/blobSync';
import type { AnyDocument, BaseDocument } from '../types';
import { toWire, type RecordCodec } from '../crypto/codec';
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
  type AdapterRecord,
  type TextMerge,
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
  StoreTasks,
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
  type NodeConfig,
  type OutboxEntry,
} from './internal';
import { lensFor, lensKey, parseLensKey, type Lens } from './lens';
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
import { TASKS, type TaskDocument } from '../tasks/task';
import { TaskRunner, type TaskWrite } from '../tasks/runner';

const encoder = new TextEncoder();

export class Store<Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[]> {
  private readonly adapter: DatabaseAdapter;
  private lens: Lens;
  private readonly definitions: ReadonlyMap<string, CollectionDefinition>;
  private readonly definitionsByKey: ReadonlyMap<string, CollectionDefinition>;
  private readonly migrator: Migrator;
  private readonly indexes: IndexManager | null;
  private readonly textCache = new TextCache();
  private readonly clock: HybridClock;
  // Writes and merges to one document run one at a time, in arrival order.
  private readonly locks = new Map<string, Promise<unknown>>();
  // Set while the lens changes: new document work waits, and the switch waits
  // for the work already queued. Switches themselves run one at a time.
  private gate: Promise<void> | null = null;
  private switches: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly changeHandlers = new Set<ChangeHandler>();
  private readonly signedOutHandlers = new Set<() => void>();
  private readonly syncEngine: SyncEngine;
  private readonly blobAdapter: BlobAdapter | null;
  // Without an extractor blob GC cannot tell referenced from orphan and must refuse to run.
  private readonly blobHashesOf: (collection: string, doc: BaseDocument) => Iterable<string>;
  private readonly hasBlobRefs: boolean;
  private readonly taskRunner: TaskRunner;

  readonly sync: StoreSync;
  readonly backup: StoreBackup;
  readonly blobs: StoreBlobs;
  readonly encryption: StoreEncryption;
  readonly ai: StoreAi;
  readonly tasks: StoreTasks;

  private constructor(options: StoreOptions<Defs>, node: string, lens: Lens) {
    this.adapter = options.adapter;
    this.lens = lens;
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
      codec: () => this.codec,
      clock: this.clock,
      node,
      activeKeys: () => this.syncedDefinitions().map((def) => this.keyOf(def)),
      activeDefinition: (key) => {
        const found = this.definitionOfKey(key);
        return found?.def.synced && found.keyId === this.lens.keyId ? found.def : undefined;
      },
      activeKeyOf: (name) => {
        const def = this.definitionByName(name);
        return def ? this.keyOf(def) : undefined;
      },
      plainKeyOf: (name) => this.definitionByName(name)?.key,
      isSyncedKey: (key) => this.definitionOfKey(key)?.def.synced === true,
      storedSyncedKeys: async () =>
        (await this.adapter.listCollections()).filter(
          (key) => this.definitionOfKey(key)?.def.synced
        ),
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
      completeSignIn: async (input) => {
        const result = await this.syncEngine.completeSignIn(input);
        if (result.ok) this.taskRunner.wake();
        return result;
      },
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
      setKey: (cipher) => this.setKey(cipher),
      moveToKey: (cipher) => this.moveToKey(cipher),
    };
    this.ai = createAi({
      credentials: () => this.syncEngine.credentials(),
      onUnauthorized: () => void this.syncEngine.handleSignedOut(),
    });
    this.taskRunner = new TaskRunner({
      list: () => this.list(TASKS) as Promise<TaskDocument[]>,
      get: (key) => this.get(TASKS, key) as Promise<TaskDocument | null>,
      mutate: (key, decide) => this.mutateTask(key, decide),
      newRev: () => this.clock.now(),
      signedIn: async () => (await this.syncEngine.credentials()) !== null,
      claimId: (key) => lensKey(key, this.lens.keyId),
      claim: (claimId, rev) => this.syncEngine.claimTask(claimId, rev),
      release: (claimId, rev) => this.syncEngine.releaseTask(claimId, rev),
      onTasksChanged: (listener) =>
        this.on('change', (collection) => {
          if (collection === TASKS.name) listener();
        }),
    });
    this.tasks = this.taskRunner.api;
  }

  static async create<Defs extends readonly CollectionDefinition[]>(
    options: StoreOptions<Defs>
  ): Promise<Store<Defs>> {
    const lens = await lensFor(options.encryption?.cipher ?? null);
    const store = new Store(options, await Store.loadNode(options.adapter), lens);
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
   * Closes realtime, stops running tasks and releases live text documents.
   * Document reads, writes and explicit sync calls keep working afterwards.
   */
  dispose(): void {
    this.disposed = true;
    this.syncEngine.stop();
    void this.taskRunner.stop();
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

  private get codec(): RecordCodec {
    return this.lens.codec;
  }

  private keyOf(def: CollectionDefinition): string {
    return lensKey(def.key, this.lens.keyId);
  }

  private definitionByName(name: string): CollectionDefinition | undefined {
    return name === TASKS.name ? TASKS : this.definitions.get(name);
  }

  private definitionOfKey(
    storageKey: string
  ): { def: CollectionDefinition; keyId: string | null } | undefined {
    const { key, keyId } = parseLensKey(storageKey);
    const def = key === TASKS.key ? TASKS : this.definitionsByKey.get(key);
    return def ? { def, keyId } : undefined;
  }

  private syncedDefinitions(): CollectionDefinition[] {
    return [...[...this.definitions.values()].filter((def) => def.synced), TASKS];
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

  // `gated` is false only for work the lens switch does itself, which would
  // otherwise wait on its own gate.
  private serialise<T>(
    collection: string,
    id: string,
    task: () => Promise<T>,
    gated = true
  ): Promise<T> {
    const key = `${collection}/${id}`;
    const previous = Promise.all([this.locks.get(key), gated ? this.gate : null]);
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
    const key = this.keyOf(def);
    const stored = await this.adapter.get(key, id);
    return stored ? this.codec.decode(key, id, stored) : null;
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
    const key = this.keyOf(def);
    await this.adapter.put(key, id, await this.seal(this.codec, key, def, id, record));
    this.indexWrite(def, id, record);
  }

  private async seal(
    codec: RecordCodec,
    key: string,
    def: CollectionDefinition,
    id: string,
    record: StoredRecord
  ): Promise<AdapterRecord> {
    const encoded = await codec.encode(key, id, record);
    const bytes = encoder.encode(toWire(encoded)).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new Error(`Document ${def.name}/${id} is ${bytes} bytes; the limit is 1 MB`);
    }
    return encoded;
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
    const key = this.keyOf(def);
    const entries = await this.adapter.getAll(key);
    return Promise.all(
      entries.map(async ({ id, record }) => ({
        id,
        raw: await this.codec.decode(key, id, record),
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
    debounceMs?: number,
    storageKey = this.keyOf(def)
  ): Promise<void> {
    if (!def.synced) return;
    const key = outboxKey(storageKey, id);
    const entry: OutboxEntry = { collection: def.name, key: storageKey, docId: id, order: clock };
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
      if (await this.adapter.get(this.keyOf(def), id)) {
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

  private async mutateTask(
    key: string,
    decide: (task: TaskDocument | null) => TaskWrite | null
  ): Promise<void> {
    const wrote = await this.serialise(TASKS.name, key, async () => {
      const existing = await this.loadRecord(TASKS, key);
      const live =
        existing && !existing.fields.deletedAt ? this.readDoc(TASKS, key, existing) : null;
      const write = decide(live as TaskDocument | null);
      if (!write) return false;
      if (write.kind === 'replace') await this.insert(TASKS, key, write.fields, existing);
      else if (existing)
        await this.modify(
          TASKS,
          key,
          existing,
          write.kind === 'update' ? write.fields : {},
          write.kind === 'delete'
        );
      return true;
    });
    if (wrote) this.emit(TASKS.name);
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
          if (await this.adapter.get(this.keyOf(def), id)) {
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
    const entries = await this.adapter.getMany(this.keyOf(def), ids);
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
    for (const entry of await this.adapter.getAll(this.keyOf(def))) {
      const doc = await this.docFromEntry(def, entry);
      if (doc && (opts?.includeDeleted || !doc.deletedAt)) docs.push(doc);
    }
    return docs;
  }

  private async docFromEntry(
    def: CollectionDefinition,
    entry: StoredEntry
  ): Promise<AnyDocument | null> {
    const raw = await this.codec.decode(this.keyOf(def), entry.id, entry.record);
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
    incoming: StoredRecord,
    gated = true
  ): Promise<ApplyResult> {
    return this.serialise(
      def.name,
      id,
      async () => {
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
          ? textMerge((state) => this.openText(def, id, state))
          : undefined;
        const { record, changed } = mergeRecords(local, migrated, def.merge, mergeText);
        if (!changed) return 'unchanged';
        await this.putRecord(def, id, record);
        return 'applied';
      },
      gated
    );
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
    const storageKey = this.keyOf(def);
    const key = outboxKey(storageKey, id);
    const existing = await this.getConfigFrom<HeldEntry>(HELD, key);
    if (existing) {
      const held = await this.codec.decode(storageKey, id, existing.data);
      const mine = greatestClock(held);
      const theirs = greatestClock(incoming);
      if (mine !== undefined && theirs !== undefined && compareClocks(mine, theirs) >= 0)
        return 'held';
    }
    const data = await this.codec.encode(storageKey, id, incoming);
    const entry: HeldEntry = { collection: storageKey, docId: id, data };
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

  private async retryHeld(gated = true): Promise<void> {
    const touched = new Set<string>();
    for (const { id: key, record } of await this.adapter.getAll(HELD)) {
      if (isSealedRecord(record)) continue;
      const entry = record.fields as unknown as HeldEntry;
      const found = this.definitionOfKey(entry.collection);
      if (!found || found.def === TASKS || found.keyId !== this.lens.keyId) continue;
      const def = found.def;
      const incoming = await this.codec.decode(entry.collection, entry.docId, entry.data);
      if ((await this.applyIncoming(def, entry.docId, incoming, gated)) === 'held') continue;
      await this.adapter.delete(HELD, key);
      touched.add(def.name);
    }
    for (const name of touched) this.emit(name);
  }

  private async setKey(cipher: DocCipher | null): Promise<void> {
    const lens = await lensFor(cipher);
    await this.exclusively(async () => {
      if (lens.keyId !== this.lens.keyId) await this.switchLens(lens);
    });
    this.syncEngine.requestPull();
  }

  // Pulls and task runs finish before the gate goes up, since both write
  // through the document locks the gate holds back.
  private exclusively<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const resumePulls = await this.syncEngine.pausePulls();
      await this.taskRunner.stop();
      let release!: () => void;
      this.gate = new Promise<void>((resolve) => (release = resolve));
      try {
        await Promise.all(this.locks.values());
        return await task();
      } finally {
        this.gate = null;
        release();
        resumePulls();
        if (!this.disposed) this.taskRunner.resume();
      }
    };
    const result = this.switches.then(run, run);
    this.switches = result.catch(() => {});
    return result;
  }

  private async moveToKey(cipher: DocCipher | null): Promise<{ moved: number; skipped: number }> {
    const target = await lensFor(cipher);
    const result = await this.exclusively(async () => {
      const total = { moved: 0, skipped: 0 };
      if (target.keyId === this.lens.keyId) return total;
      for (const def of [...this.definitions.values(), TASKS]) {
        const { moved, skipped } = await this.moveAll(def, target);
        total.moved += moved;
        total.skipped += skipped;
      }
      await this.switchLens(target);
      return total;
    });
    this.syncEngine.requestPull();
    return result;
  }

  // Each document is written to the target before it is tombstoned here, so
  // an interrupted move leaves the rest live in this lens for a rerun. A
  // document already in the target merges by the usual rules.
  private async moveAll(
    def: CollectionDefinition,
    target: Lens
  ): Promise<{ moved: number; skipped: number }> {
    const targetKey = lensKey(def.key, target.keyId);
    const current = this.migrator.currentVersion(def.name);
    const total = { moved: 0, skipped: 0 };
    for (const { id, raw } of await this.allRecords(def)) {
      const record = await this.materialise(def, id, raw);
      if (record?.fields.deletedAt) continue;
      if (!record || !this.readDoc(def, id, record)) {
        total.skipped += 1;
        continue;
      }
      let moved = record;
      const stored = await this.adapter.get(targetKey, id);
      if (stored) {
        const theirs = await target.codec.decode(targetKey, id, stored);
        if (theirs.schemaVersion > current) {
          total.skipped += 1;
          continue;
        }
        const migrated = needsMigration(this.migrator, def, theirs)
          ? migrateRecord(this.migrator, def, theirs)
          : theirs;
        const mergeText = def.textEngine
          ? textMerge((state) => def.textEngine!.open(def.textFields, state), { detached: true })
          : undefined;
        moved = mergeRecords(migrated, record, def.merge, mergeText).record;
        if (moved.fields.deletedAt)
          moved = this.revive(def, def.merge === 'document' ? record : moved);
      }
      await this.adapter.put(
        targetKey,
        id,
        await this.seal(target.codec, targetKey, def, id, moved)
      );
      const clock = greatestClock(moved);
      if (clock !== undefined) await this.queueOutbox(def, id, clock, undefined, targetKey);
      await this.modify(def, id, record, {}, true);
      total.moved += 1;
    }
    return total;
  }

  // A tombstone in the target, such as one left by an earlier move away,
  // must not swallow a document moved there on purpose.
  private revive(def: CollectionDefinition, record: StoredRecord): StoredRecord {
    const revived: StoredRecord = { ...record, fields: { ...record.fields, deletedAt: null } };
    this.stamp(def, revived, ['deletedAt'], this.clock.now());
    return revived;
  }

  private async switchLens(lens: Lens): Promise<void> {
    await this.rememberBlobHashes();
    await this.syncEngine.leaveLens(this.syncedDefinitions().map((def) => this.keyOf(def)));
    this.lens = lens;
    this.textCache.clear();
    await this.retryHeld(false);
    await this.buildIndexes();
    for (const name of [...this.definitions.keys(), TASKS.name]) this.emit(name);
  }

  // Blobs live outside lenses, so pruning must keep what the other lenses
  // reference. Their documents cannot be read from here, so each lens leaves
  // behind the hashes it referenced when it was last active.
  private async rememberBlobHashes(): Promise<void> {
    if (!this.hasBlobRefs) return;
    const lenses = await this.lensBlobHashes();
    lenses[this.lens.keyId ?? ''] = Array.from(await this.activeBlobHashes());
    await this.setConfig('lensBlobHashes', { lenses });
  }

  private async lensBlobHashes(): Promise<Record<string, string[]>> {
    return (
      (await this.getConfig<{ lenses: Record<string, string[]> }>('lensBlobHashes'))?.lenses ?? {}
    );
  }

  private async activeBlobHashes(): Promise<Set<string>> {
    const refs = new Set<string>();
    for (const def of this.definitions.values()) {
      for (const doc of await this.list(def)) {
        for (const hash of this.blobHashesOf(def.name, doc)) refs.add(hash);
      }
    }
    return refs;
  }

  private async referencedBlobHashes(): Promise<Set<string>> {
    if (!this.hasBlobRefs) return new Set();
    const refs = await this.activeBlobHashes();
    for (const [keyId, hashes] of Object.entries(await this.lensBlobHashes())) {
      if (keyId === (this.lens.keyId ?? '')) continue;
      for (const hash of hashes) refs.add(hash);
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
        for (const { id } of await this.adapter.getAll(this.keyOf(def))) {
          await this.adapter.delete(this.keyOf(def), id);
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

// Detached documents are opened for one merge and destroyed; cached ones stay
// live in the text cache.
function textMerge(
  open: (state: string | undefined) => TextDocument,
  opts: { detached?: boolean } = {}
): TextMerge {
  return (mine, theirs) => {
    const doc = open(mine);
    try {
      if (theirs !== undefined) doc.merge(theirs);
      return doc.encode();
    } finally {
      if (opts.detached) doc.destroy();
    }
  };
}
