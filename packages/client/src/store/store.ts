import dayjs from 'dayjs';
import { randomId } from '../ids';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';
import type { BaseDocument } from '../types';
import {
  SyncClient,
  registerClient as registerClientFetch,
  type RegisterResult,
} from '../sync/sync';
import { LOCAL_AUTHOR_ID, SYSTEM_AUTHOR_ID } from '../system';
import { RealtimeConnection } from '../sync/realtime';
import { Migrator, noopMigrator } from '../migrator';
import type { ParsedId } from '../collection';
import {
  packBackup,
  unpackBackup,
  BACKUP_FORMAT_VERSION,
  type BackupBlob,
} from '../backup/archive';
import { SyncEngine } from './syncEngine';
import { Collection } from './collectionRef';
import { seedContentEqual } from './helpers';
import type {
  StoreOptions,
  StoreDomain,
  ClientConfigDoc,
  AuthorConfigDoc,
  ClientRegistration,
  ChangeHandler,
  SeedSet,
  SeedMarkerDoc,
  RestoreMode,
  RestoreResult,
} from './types';

export class Store {
  private realtime: RealtimeConnection | null = null;
  private realtimeEnabled: boolean;
  private changeHandlers = new Set<ChangeHandler>();
  private cachedAuthorId: string = LOCAL_AUTHOR_ID;
  private adapter: DatabaseAdapter;
  private readonly migrator: Migrator;
  private readonly validate: (collection: string, doc: unknown) => unknown;
  private readonly collections: readonly string[];
  private readonly idParser: (id: string) => ParsedId | null;
  private readonly onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
  // Owns the push outbox, pulls, and cursors. Fed live views of this Store's
  // author id + change emitter; its SyncClient is swapped in/out by the
  // client-registration methods below.
  private readonly sync: SyncEngine;
  /**
   * Sidecar for opaque byte blobs. Null on consumers that only deal in
   * JSON docs (e.g. CLI tools). A BlobStore requires a non-null blobs.
   */
  readonly blobs: BlobAdapter | null;

  constructor(
    adapter: DatabaseAdapter,
    blobs: BlobAdapter | null,
    domain: StoreDomain = {},
    options?: StoreOptions
  ) {
    this.adapter = adapter;
    this.blobs = blobs;
    this.migrator = domain.migrator ?? noopMigrator;
    this.collections = domain.collections ?? [];
    this.idParser = domain.parseId ?? (() => null);
    this.onSetAuthor = domain.onSetAuthor;
    this.validate = (collection, doc) => {
      const stamped = {
        ...(doc as object),
        schemaVersion: this.migrator.currentVersion(collection),
      };
      return domain.validate ? domain.validate(collection, stamped) : stamped;
    };
    this.realtimeEnabled = options?.realtime ?? false;
    this.sync = new SyncEngine({
      adapter: this.adapter,
      migrator: this.migrator,
      collections: this.collections,
      pullOnRead: options?.pullOnRead ?? false,
      getAuthorId: () => this.cachedAuthorId,
      emit: (collection) => this.emit(collection),
    });
    this.sync.setSyncClient(
      options?.syncUrl && options.syncToken
        ? new SyncClient(options.syncUrl, options.syncToken)
        : null
    );
    if (options?.syncUrl && options?.syncToken) {
      this.openRealtime(options.syncUrl, options.syncToken);
    }
  }

  private openRealtime(url: string, token: string): void {
    if (!this.realtimeEnabled) return;
    this.realtime?.stop();
    this.realtime = new RealtimeConnection({
      url,
      token,
      // Internal `_`-prefixed collections are per-store bookkeeping (e.g. the
      // `_seeds` marker); pulling another party's copy would clobber ours.
      onInvalidate: (collection) => {
        if (!collection.startsWith('_')) void this.sync.pull(collection);
      },
      onReconnect: () => {
        // Regained connectivity: pull others' changes and flush any writes
        // whose push failed while we were offline.
        void this.sync.pullRegisteredCollections();
        void this.sync.drainOutbox().catch(() => {});
      },
    });
    void this.realtime.start();
  }

  on(event: 'change', handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  /**
   * Tear down the realtime WebSocket if one is open. Safe to call repeatedly.
   * Document mutations and HTTP sync continue to work after this.
   */
  dispose(): void {
    this.realtime?.stop();
    this.realtime = null;
  }

  private emit(collection: string): void {
    for (const handler of this.changeHandlers) handler(collection);
  }

  /**
   * Signal that the local blob set has changed (capture, pull, delete).
   * Routed through the same `change` channel as document collections so
   * UI invalidation can hang off a single subscription.
   */
  notifyBlobsChanged(): void {
    this.emit('_blobs');
  }

  static async create(
    adapter: DatabaseAdapter,
    blobs: BlobAdapter | null = null,
    domain: StoreDomain = {},
    options?: { realtime?: boolean; pullOnRead?: boolean }
  ): Promise<Store> {
    const clientDoc = await adapter.get<ClientConfigDoc>('_config', 'client');
    // Capability flags (realtime, pullOnRead) must survive even when there's no
    // client doc yet: on a fresh install the user registers a server *after*
    // create(), and registerClient() only opens realtime if the flag was set
    // here. Folding it into the clientDoc branch left realtime dead until the
    // next app restart.
    const storeOptions: StoreOptions = {
      realtime: options?.realtime,
      pullOnRead: options?.pullOnRead,
      ...(clientDoc ? { syncUrl: clientDoc.url, syncToken: clientDoc.token } : {}),
    };
    const store = new Store(adapter, blobs, domain, storeOptions);
    // Pre-sync, the author is implicitly LOCAL_AUTHOR_ID. If a real identity
    // was previously claimed (via a sync server), restore it from the author
    // config doc.
    const authorDoc = await adapter.get<AuthorConfigDoc>('_config', 'author');
    if (authorDoc) store.cachedAuthorId = authorDoc.authorId;
    return store;
  }

  // Current author

  async setAuthor(authorId: string): Promise<void> {
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

  async getCurrentAuthor(): Promise<string> {
    return this.cachedAuthorId;
  }

  /**
   * Resolve a document id to its collection (and parts) via the domain's
   * prefix map. Returns `null` for ids with an unknown prefix.
   */
  parseId(id: string): ParsedId | null {
    return this.idParser(id);
  }

  // Client registration / sync config

  /**
   * Trade the server password for a long-lived access token bound to this
   * client. The clientId is generated once on first call and reused on every
   * subsequent call (persisted in `_config/client`), so re-registering — to
   * rotate the token, rename the client, or point at a different URL — keeps
   * the same identity on the server side.
   */
  async registerClient(url: string, password: string, clientName: string): Promise<RegisterResult> {
    const normalisedUrl = url.replace(/\/+$/, '');
    const existing = await this.adapter.get<ClientConfigDoc>('_config', 'client');
    const clientId = existing?.clientId ?? `cl-${randomId(10)}`;
    const result = await registerClientFetch(normalisedUrl, password, clientId, clientName);
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
    } as ClientConfigDoc);
    this.sync.setSyncClient(new SyncClient(normalisedUrl, result.token));
    this.openRealtime(normalisedUrl, result.token);
    return result;
  }

  async getClientRegistration(): Promise<ClientRegistration | null> {
    const doc = await this.adapter.get<ClientConfigDoc>('_config', 'client');
    return doc ? { id: doc.clientId, name: doc.clientName, url: doc.url } : null;
  }

  /**
   * Returns the raw url + access token. Internal-use only — surfaces of
   * a consuming app should call `getClientRegistration` instead, which
   * strips the token. Exposed so the repo layer can hand the token to
   * helpers that issue HTTP calls directly.
   */
  async getSyncCredentials(): Promise<{ url: string; token: string } | null> {
    const doc = await this.adapter.get<ClientConfigDoc>('_config', 'client');
    return doc ? { url: doc.url, token: doc.token } : null;
  }

  async clearClientRegistration(): Promise<void> {
    await this.adapter.delete('_config', 'client');
    this.sync.setSyncClient(null);
    this.realtime?.stop();
    this.realtime = null;
  }

  /**
   * Clear all local data and reset to the unidentified local author. There is
   * deliberately no remote-wipe path: a single client credential must not be
   * able to erase the household's shared server database. Server data is wiped
   * out-of-band by the operator (see @pact/server).
   */
  async wipe(): Promise<void> {
    await this.adapter.wipe();
    this.cachedAuthorId = LOCAL_AUTHOR_ID;
  }

  async wipeAuthor(authorId: string): Promise<void> {
    const collections = await this.adapter.listCollections();
    await Promise.all(
      collections
        .filter((c) => !c.startsWith('_'))
        .map(async (collection) => {
          const all = await this.adapter.getAll<BaseDocument>(collection);
          const ids = all.filter((d) => d.createdBy === authorId && !d.deletedAt).map((d) => d.id);
          if (ids.length > 0) await this.deleteMany(collection, ids);
        })
    );
  }

  // CRUD

  private validateDoc<T>(collection: string, doc: T): T {
    return this.validate(collection, doc) as T;
  }

  /**
   * Run on every read. If the doc is behind the collection's current
   * schemaVersion, upgrade it via the migration chain. Upgraded docs are
   * lazily written back so old versions drain from local storage over
   * time. Internal `_config`/`_sync_meta` collections aren't in the
   * registry and short-circuit to a no-op.
   */
  private migrateRead<T>(collection: string, doc: T | null): T | null {
    if (!doc) return doc;
    if (!this.migrator.needsMigration(collection, doc)) return doc;
    const upgraded = this.migrator.migrate<T>(collection, doc);
    // Fire-and-forget write-back. Failure here isn't fatal — the next read
    // will just migrate again.
    this.adapter.put(collection, upgraded as unknown as BaseDocument).catch(() => {});
    return upgraded;
  }

  private async requireAuthor(): Promise<string> {
    return this.getCurrentAuthor();
  }

  /**
   * Reassigns every local document with `createdBy`, `updatedBy`, or
   * `deletedBy` === `LOCAL_AUTHOR_ID` to the given author id, bumping
   * `updatedAt` so the next push picks them up. `deletedBy` is included so a
   * doc soft-deleted before identity was claimed doesn't sync a tombstone
   * still tagged with the local sentinel. Skips internal `_*` collections.
   */
  async reassignLocalAuthor(newAuthorId: string): Promise<void> {
    if (newAuthorId === LOCAL_AUTHOR_ID || newAuthorId === SYSTEM_AUTHOR_ID) {
      throw new Error('Cannot reassign local docs to a system or local author id');
    }
    const collections = await this.adapter.listCollections();
    const now = dayjs().toISOString();
    for (const collection of collections) {
      if (collection.startsWith('_')) continue;
      const all = await this.adapter.getAll<BaseDocument>(collection);
      for (const raw of all) {
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
        await this.adapter.put(collection, updated);
      }
      this.emit(collection);
    }
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    this.sync.triggerReadPull(collection);
    const doc = this.migrateRead<T>(collection, await this.adapter.get<T>(collection, id));
    return doc?.deletedAt ? null : doc;
  }

  /** Like `get`, but returns soft-deleted docs too. Seeding uses this so it can
   *  tell "author deleted this seed" apart from "doc never existed". */
  async getIncludingDeleted<T extends BaseDocument>(
    collection: string,
    id: string
  ): Promise<T | null> {
    return this.migrateRead<T>(collection, await this.adapter.get<T>(collection, id));
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    this.sync.triggerReadPull(collection);
    const docs = await this.adapter.getMany<T>(collection, ids);
    return docs
      .map((doc) => this.migrateRead<T>(collection, doc) as T)
      .filter((doc) => !doc.deletedAt);
  }

  async list<T extends BaseDocument>(collection: string): Promise<T[]> {
    this.sync.triggerReadPull(collection);
    const all = await this.adapter.getAll<T>(collection);
    return all
      .map((doc) => this.migrateRead<T>(collection, doc) as T)
      .filter((doc) => !doc.deletedAt);
  }

  /** Like `list`, but includes soft-deleted docs (tombstones). Inspect
   *  `deletedAt` on each result to tell them apart. For debug/admin surfaces. */
  async listIncludingDeleted<T extends BaseDocument>(collection: string): Promise<T[]> {
    this.sync.triggerReadPull(collection);
    const all = await this.adapter.getAll<T>(collection);
    return all.map((doc) => this.migrateRead<T>(collection, doc) as T);
  }

  async createAsSystem<T extends BaseDocument>(
    collection: string,
    id: string,
    input: Omit<T, keyof BaseDocument>
  ): Promise<T> {
    const now = dayjs().toISOString();
    const doc = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
      createdBy: SYSTEM_AUTHOR_ID,
      updatedBy: SYSTEM_AUTHOR_ID,
      deletedAt: null,
      deletedBy: null,
    } as unknown as T;
    const validated = this.validateDoc(collection, doc);
    await this.adapter.put(collection, validated);
    this.emit(collection);
    return validated;
  }

  /**
   * Apply a versioned seed payload. No-op while the locally stored `_seeds`
   * marker matches `seeds.version` (pass `force` to bypass, e.g. a manual
   * "restore seed data" action). Writes are local-only; they reach a sync
   * server through the normal push paths, or directly when the adapter itself
   * fronts the server's database.
   *
   * Per-doc semantics:
   * - Untouched docs (still system-authored) are overwritten wholesale, but
   *   only when content actually changed — re-running is cheap.
   * - Docs a real author edited keep every field that has a value; fields the
   *   seed provides that are still `undefined` on the doc are filled in
   *   (enrichment). `undefined` is the only fillable state — an explicit
   *   `null` is somebody's decision and is never overridden. The doc stays
   *   author-touched so later seeds still can't clobber it.
   * - Docs a real author deleted stay deleted.
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
        if (this.adapter.putMany) {
          await this.adapter.putMany(collection, pending);
        } else {
          for (const doc of pending) await this.adapter.put(collection, doc);
        }
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

  async create<T extends BaseDocument>(
    collection: string,
    id: string,
    input: Omit<T, keyof BaseDocument>
  ): Promise<T> {
    const authorId = await this.requireAuthor();
    const now = dayjs().toISOString();
    const doc = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
      createdBy: authorId,
      updatedBy: authorId,
      deletedAt: null,
      deletedBy: null,
    } as unknown as T;
    const validated = this.validateDoc(collection, doc);
    await this.adapter.put(collection, validated);
    await this.sync.queuePush(collection, [validated.id]);
    this.emit(collection);
    return validated;
  }

  async update<T extends BaseDocument>(
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
    await this.adapter.put(collection, validated);
    await this.sync.queuePush(collection, [validated.id]);
    this.emit(collection);
    return validated;
  }

  async delete(collection: string, id: string): Promise<void> {
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
    await this.adapter.put(collection, deleted);
    await this.sync.queuePush(collection, [deleted.id]);
    this.emit(collection);
  }

  async createMany<T extends BaseDocument>(
    collection: string,
    items: Array<{ id: string } & Omit<T, keyof BaseDocument>>
  ): Promise<T[]> {
    const authorId = await this.requireAuthor();
    const now = dayjs().toISOString();
    const docs = items.map(({ id, ...input }) => {
      const doc = {
        ...input,
        id,
        createdAt: now,
        updatedAt: now,
        createdBy: authorId,
        updatedBy: authorId,
        deletedAt: null,
        deletedBy: null,
      } as unknown as T;
      return this.validateDoc(collection, doc);
    });
    await Promise.all(docs.map((doc) => this.adapter.put(collection, doc)));
    await this.sync.queuePush(
      collection,
      docs.map((doc) => doc.id)
    );
    this.emit(collection);
    return docs;
  }

  async updateMany<T extends BaseDocument>(
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
    await Promise.all(docs.map((doc) => this.adapter.put(collection, doc)));
    await this.sync.queuePush(
      collection,
      docs.map((doc) => doc.id)
    );
    this.emit(collection);
    return docs;
  }

  async deleteMany(collection: string, ids: string[]): Promise<void> {
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
    await Promise.all(deleted.map((doc) => this.adapter.put(collection, doc)));
    await this.sync.queuePush(
      collection,
      deleted.map((doc) => doc.id)
    );
    this.emit(collection);
  }

  /**
   * Removes a document from local storage outright — no tombstone, no sync
   * push. Unlike `delete`, this leaves nothing behind, so a later reseed (or
   * any `getIncludingDeleted` consumer) treats the doc as never-having-existed.
   * Intended for low-level/debug use; normal deletes should go through
   * `delete`/`deleteMany` so the tombstone propagates to other devices. A doc
   * that still exists on the server will re-pull on the next sync.
   */
  async hardDelete(collection: string, id: string): Promise<void> {
    await this.adapter.delete(collection, id);
    this.emit(collection);
  }

  /** Batch form of `hardDelete`. */
  async hardDeleteMany(collection: string, ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.adapter.delete(collection, id)));
    this.emit(collection);
  }

  // Sync — thin delegations to the SyncEngine, preserving the public surface.

  pushAll(): Promise<void> {
    return this.sync.pushAll();
  }

  drainOutbox(): Promise<void> {
    return this.sync.drainOutbox();
  }

  /** Count of documents written locally but not yet accepted by the server. */
  pendingPushCount(): Promise<number> {
    return this.sync.pendingPushCount();
  }

  pull<T extends BaseDocument>(collection: string): Promise<T[]> {
    return this.sync.pull<T>(collection);
  }

  /**
   * Drop all locally-cached state except `_config` (sync credentials + author
   * identity), then re-pull every registered collection from a fresh cursor.
   * Unlike `wipe`, the install stays registered and identified. Clears the
   * outbox, so callers with unsynced writes that matter must `drainOutbox`
   * first. Intended as a one-off recovery after the server's documents were
   * rewritten out-of-band (e.g. an id-format change) and the local copies can
   * no longer be reconciled doc-by-doc.
   */
  async resyncFromScratch(): Promise<void> {
    const collections = await this.adapter.listCollections();
    for (const collection of collections) {
      if (collection === '_config') continue;
      const all = await this.adapter.getAll<BaseDocument>(collection);
      if (all.length > 0) {
        await this.hardDeleteMany(
          collection,
          all.map((d) => d.id)
        );
      }
    }
    await this.sync.pullRegisteredCollections();
  }

  // Backup / restore — a self-contained, server-independent snapshot.

  /**
   * Pack every document (tombstones included) into a single portable archive,
   * optionally bundling the local blobs. Internal `_*` collections — sync
   * credentials, pull cursors, the push outbox — are excluded: they're
   * device-specific and must not travel. The result is a `Uint8Array` the
   * caller persists however it likes (a file, a cloud object); the framework
   * makes no filesystem assumption.
   *
   * Blobs are included by default when this store has a `BlobAdapter`; pass
   * `{ blobs: false }` for a documents-only archive (blobs can be re-pulled
   * from a sync server later via their referenced hashes).
   */
  async createBackup(opts?: { blobs?: boolean }): Promise<Uint8Array> {
    const collections: Record<string, BaseDocument[]> = {};
    for (const name of await this.adapter.listCollections()) {
      if (name.startsWith('_')) continue;
      const docs = await this.adapter.getAll<BaseDocument>(name);
      if (docs.length > 0) collections[name] = docs;
    }

    const includeBlobs = (opts?.blobs ?? true) && this.blobs !== null;
    const blobs: BackupBlob[] = [];
    if (includeBlobs && this.blobs) {
      for (const hash of await this.blobs.list()) {
        const bytes = await this.blobs.read(hash);
        if (!bytes) continue;
        const mimeType = (await this.blobs.mimeType(hash)) ?? 'application/octet-stream';
        blobs.push({ hash, mimeType, bytes });
      }
    }

    return packBackup(
      { formatVersion: BACKUP_FORMAT_VERSION, createdAt: dayjs().toISOString(), collections },
      blobs
    );
  }

  /**
   * Load an archive produced by `createBackup`. Docs are written raw so their
   * audit fields and `schemaVersion` survive intact (reads migrate lazily, as
   * with pulled docs); restored docs reach a sync server on the next
   * `pushAll`. Throws if `archive` isn't a recognized backup.
   *
   * `mode` defaults to `merge` (last-write-wins, safe on a live store); see
   * `RestoreMode`.
   */
  async restoreBackup(archive: Uint8Array, opts?: { mode?: RestoreMode }): Promise<RestoreResult> {
    const mode = opts?.mode ?? 'merge';
    const { manifest, blobs } = unpackBackup(archive);
    const collections = Object.keys(manifest.collections);

    let docsWritten = 0;
    let docsSkipped = 0;
    for (const name of collections) {
      const incoming = manifest.collections[name];
      if (mode === 'replace') {
        const existing = await this.adapter.getAll<BaseDocument>(name);
        await Promise.all(existing.map((d) => this.adapter.delete(name, d.id)));
      }
      const toWrite: BaseDocument[] = [];
      for (const doc of incoming) {
        if (mode === 'merge') {
          // Last-write-wins, mirroring the pull path (syncEngine): skip only
          // when the local copy is strictly newer; ties go to the archive.
          const local = await this.adapter.get<BaseDocument>(name, doc.id);
          if (local && local.updatedAt > doc.updatedAt) {
            docsSkipped++;
            continue;
          }
        }
        toWrite.push(doc);
      }
      if (toWrite.length > 0) {
        if (this.adapter.putMany) await this.adapter.putMany(name, toWrite);
        else for (const doc of toWrite) await this.adapter.put(name, doc);
        docsWritten += toWrite.length;
        this.emit(name);
      }
    }

    let blobsWritten = 0;
    let blobsSkipped = 0;
    if (blobs.length > 0) {
      if (!this.blobs) {
        blobsSkipped = blobs.length;
      } else {
        if (mode === 'replace') {
          for (const hash of await this.blobs.list()) await this.blobs.delete(hash);
        }
        for (const blob of blobs) {
          // Content-addressed: a present hash already holds these exact bytes,
          // so skip it in merge mode. Replace cleared the set above.
          if (mode === 'merge' && (await this.blobs.has(blob.hash))) continue;
          await this.blobs.write(blob.hash, blob.bytes, blob.mimeType);
          blobsWritten++;
        }
        if (blobsWritten > 0) this.notifyBlobsChanged();
      }
    }

    return { mode, collections, docsWritten, docsSkipped, blobsWritten, blobsSkipped };
  }

  pullDocument<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    return this.sync.pullDocument<T>(collection, id);
  }

  getLastSyncedAt(collections: string[]): Promise<Date | null> {
    return this.sync.getLastSyncedAt(collections);
  }

  collection<T extends BaseDocument>(name: string): Collection<T> {
    return new Collection<T>(this, name);
  }
}
