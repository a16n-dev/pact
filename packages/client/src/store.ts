import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import type { DatabaseAdapter } from './adapters/adapter';
import type { BlobAdapter } from './blobs/blobAdapter';
import type { BaseDocument } from './types';
import {
  SyncClient,
  registerClient as registerClientFetch,
  type RegisterResult,
} from './sync/sync';
import { LOCAL_AUTHOR_ID, SYSTEM_AUTHOR_ID } from './system';
import { RealtimeConnection } from './sync/realtime';
import { Migrator, noopMigrator } from './migrator';

export interface StoreOptions {
  syncUrl?: string;
  syncToken?: string;
  realtime?: boolean;
  /**
   * When true, every `get`/`getMany`/`list` kicks off a background pull for
   * that collection (deduped per in-flight collection and throttled to
   * `READ_PULL_THROTTLE_MS`). A no-op without sync credentials.
   */
  pullOnRead?: boolean;
}

// Floor on how often a single collection re-pulls in response to reads. Reads
// fire on every render that touches a hook, so without this a busy screen
// would spray pulls; realtime + foreground sync cover the gaps in between.
const READ_PULL_THROTTLE_MS = 10_000;

/**
 * Hooks injected by the consuming domain package. The Store treats stored
 * docs as opaque `BaseDocument`-shaped bags; this config tells it how to
 * validate writes, walk migrations, and enumerate known collections for
 * batch operations (pull-all, push-all). All fields are optional — when
 * omitted, the Store skips that step.
 */
export interface StoreDomain {
  /**
   * Validate (and stamp `schemaVersion` on) a doc before it's written.
   * Typically a Zod schema parse. Throws to reject the write.
   */
  validate?: (collection: string, doc: unknown) => unknown;
  /**
   * Migrator pre-bound to the domain's migration registry. Defaults to a
   * no-op (docs pass through unchanged, currentVersion always returns 1).
   */
  migrator?: Migrator;
  /**
   * Collections the Store iterates over for `pushAll` / pull-all-on-reconnect.
   * Omit to fall back to whatever the adapter currently has data for.
   */
  collections?: readonly string[];
  /**
   * Called from `setAuthor` after the current-author id is recorded, with
   * the Store and the new author id. The generic Store only tracks *who* the
   * current author is (in `_config/author`); domains that model the author as
   * an actual document use this hook to materialize that entity (e.g. create
   * a `users/<id>` doc). No-op when omitted.
   */
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
}

type ClientConfigDoc = BaseDocument & {
  clientId: string;
  clientName: string;
  url: string;
  token: string;
};
type AuthorConfigDoc = BaseDocument & { authorId: string };

export interface ClientRegistration {
  id: string;
  name: string;
  url: string;
}

type ChangeHandler = (collection: string) => void;

/**
 * A versioned set of seed documents for `Store.seed`. `docs` entries carry the
 * document content (sans audit fields) plus its id; the Store stamps audit
 * fields and validates on write. `version` identifies the payload — seeding is
 * skipped entirely while the stored marker matches it, so derive it from the
 * seed content (e.g. a hash) or bump it manually on every seed change.
 */
export interface SeedSet {
  version: string;
  docs: ReadonlyMap<string, ReadonlyArray<{ id: string } & Record<string, unknown>>>;
}

type SeedMarkerDoc = BaseDocument & { version: string };

/** Field-wise equality ignoring audit timestamps — used to skip seed writes
 *  that would change nothing but `updatedAt`. */
function seedContentEqual(a: BaseDocument, b: BaseDocument): boolean {
  const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: BaseDocument) => rest;
  return deepEqual(strip(a), strip(b));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

export class Store {
  private syncClient: SyncClient | null;
  private realtime: RealtimeConnection | null = null;
  private realtimeEnabled: boolean;
  private readonly pullOnReadEnabled: boolean;
  private readonly lastReadPullAt = new Map<string, number>();
  private readonly inFlightReadPulls = new Set<string>();
  // Coalesces concurrent outbox drains: `drainTask` is the in-flight drain, so
  // callers await the same one; `drainPending` flags that another drain was
  // requested mid-flight, making the runner take one more pass (a write enqueued
  // — or a retry requested — during a drain isn't stranded).
  private drainTask: Promise<void> | null = null;
  private drainPending = false;
  private changeHandlers = new Set<ChangeHandler>();
  private cachedAuthorId: string = LOCAL_AUTHOR_ID;
  private adapter: DatabaseAdapter;
  private readonly migrator: Migrator;
  private readonly validate: (collection: string, doc: unknown) => unknown;
  private readonly collections: readonly string[];
  private readonly onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
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
    this.onSetAuthor = domain.onSetAuthor;
    this.validate = (collection, doc) => {
      const stamped = {
        ...(doc as object),
        schemaVersion: this.migrator.currentVersion(collection),
      };
      return domain.validate ? domain.validate(collection, stamped) : stamped;
    };
    this.syncClient =
      options?.syncUrl && options.syncToken
        ? new SyncClient(options.syncUrl, options.syncToken)
        : null;
    this.realtimeEnabled = options?.realtime ?? false;
    this.pullOnReadEnabled = options?.pullOnRead ?? false;
    if (options?.syncUrl && options?.syncToken) {
      this.openRealtime(options.syncUrl, options.syncToken);
    }
  }

  /**
   * Fire-and-forget background pull triggered by a read, when `pullOnRead` is
   * on. Deduped while a pull for the collection is in flight and throttled to
   * `READ_PULL_THROTTLE_MS` so re-renders don't spray requests. The applied
   * docs emit `change`, which the UI layer turns into a refetch — and that
   * refetch is throttled out here, so there's no read→pull→read loop.
   */
  private triggerReadPull(collection: string): void {
    if (!this.pullOnReadEnabled || !this.syncClient) return;
    if (collection.startsWith('_')) return;
    if (this.inFlightReadPulls.has(collection)) return;
    const now = dayjs().valueOf();
    if (now - (this.lastReadPullAt.get(collection) ?? 0) < READ_PULL_THROTTLE_MS) return;
    this.lastReadPullAt.set(collection, now);
    this.inFlightReadPulls.add(collection);
    void this.pull(collection)
      .catch(() => {})
      .finally(() => this.inFlightReadPulls.delete(collection));
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
        if (!collection.startsWith('_')) void this.pull(collection);
      },
      onReconnect: () => {
        // Regained connectivity: pull others' changes and flush any writes
        // whose push failed while we were offline.
        void this.pullRegisteredCollections();
        void this.drainOutbox().catch(() => {});
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

  private async pullRegisteredCollections(): Promise<void> {
    const list =
      this.collections.length > 0 ? this.collections : await this.adapter.listCollections();
    await Promise.all(
      list.filter((c) => !c.startsWith('_')).map((c) => this.pull(c).catch(() => {}))
    );
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
    const clientId = existing?.clientId ?? `cl/${nanoid(10)}`;
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
    this.syncClient = new SyncClient(normalisedUrl, result.token);
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
    this.syncClient = null;
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
    this.triggerReadPull(collection);
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
    this.triggerReadPull(collection);
    const docs = await this.adapter.getMany<T>(collection, ids);
    return docs
      .map((doc) => this.migrateRead<T>(collection, doc) as T)
      .filter((doc) => !doc.deletedAt);
  }

  async list<T extends BaseDocument>(collection: string): Promise<T[]> {
    this.triggerReadPull(collection);
    const all = await this.adapter.getAll<T>(collection);
    return all
      .map((doc) => this.migrateRead<T>(collection, doc) as T)
      .filter((doc) => !doc.deletedAt);
  }

  /** Like `list`, but includes soft-deleted docs (tombstones). Inspect
   *  `deletedAt` on each result to tell them apart. For debug/admin surfaces. */
  async listIncludingDeleted<T extends BaseDocument>(collection: string): Promise<T[]> {
    this.triggerReadPull(collection);
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
    await this.queuePush(collection, [validated.id]);
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
    await this.queuePush(collection, [validated.id]);
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
    await this.queuePush(collection, [deleted.id]);
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
    await this.queuePush(
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
    await this.queuePush(
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
    await this.queuePush(
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

  async pushAll(): Promise<void> {
    if (!this.syncClient) return;
    const list =
      this.collections.length > 0 ? this.collections : await this.adapter.listCollections();
    for (const collection of list) {
      if (collection.startsWith('_')) continue;
      const raw = await this.adapter.getAll<BaseDocument>(collection);
      const docs = raw.map((doc) => this.migrator.migrate<BaseDocument>(collection, doc));
      if (docs.length > 0) {
        await this.syncClient.push(collection, docs);
      }
    }
  }

  /**
   * Record documents as needing a push, then kick a drain. This replaces a
   * fire-and-forget `push`: the queue entry is written to local storage first,
   * so a push that fails — offline, server error, or the app dying mid-flight —
   * is retried on the next drain instead of being silently lost. No-op without
   * a sync client: a purely local store (CLI, the in-Worker D1 adapter) has
   * nowhere to push and must not accumulate a queue.
   */
  private async queuePush(collection: string, ids: readonly string[]): Promise<void> {
    if (!this.syncClient || ids.length === 0) return;
    const now = dayjs().toISOString();
    const author = this.cachedAuthorId;
    const entries: OutboxDoc[] = ids.map((docId) => ({
      id: outboxKey(collection, docId),
      schemaVersion: this.migrator.currentVersion(OUTBOX),
      createdAt: now,
      updatedAt: now,
      createdBy: author,
      updatedBy: author,
      deletedAt: null,
      deletedBy: null,
      collection,
      docId,
    }));
    // Keyed by collection+id, so re-editing a still-pending doc overwrites its
    // entry rather than queuing a duplicate — the drain sends the latest version.
    if (this.adapter.putMany) await this.adapter.putMany(OUTBOX, entries);
    else for (const entry of entries) await this.adapter.put(OUTBOX, entry);
    this.emit(OUTBOX);
    void this.drainOutbox().catch(() => {});
  }

  /**
   * Push every queued document to the server, clearing entries the server
   * accepts. The single mechanism that moves local writes upstream; safe to
   * call anytime. Triggered on each mutation, on realtime reconnect, and on a
   * full sync. Concurrent calls coalesce. Stops on the first failing collection
   * and leaves the rest queued for the next trigger rather than spinning while
   * offline.
   */
  async drainOutbox(): Promise<void> {
    if (!this.syncClient) return;
    // Pre-identity writes are local-authored and the server rejects them (a
    // client must claim an identity first). Leave them queued — the claim flow
    // pushes them once an author is assigned.
    if (this.cachedAuthorId === LOCAL_AUTHOR_ID) return;
    // Mark a drain wanted *before* checking for one in flight: a concurrent
    // drain sees this flag and takes another pass, and we await that same task
    // so a coalesced caller still observes a settled drain. The window between
    // the loop's last `drainPending` check and clearing `drainTask` is fully
    // synchronous, so no request can slip through unobserved.
    this.drainPending = true;
    if (!this.drainTask) this.drainTask = this.runDrain();
    return this.drainTask;
  }

  private async runDrain(): Promise<void> {
    try {
      while (this.drainPending) {
        this.drainPending = false;
        await this.drainOnce();
        // Loop only if another drain was requested mid-pass (a fresh write, or a
        // retry after connectivity returned). A failed pass leaves its entries
        // queued and, absent a new request, exits — no spin while offline.
      }
    } finally {
      // Clear here, in the same synchronous continuation as the loop's exit, so
      // there's no gap in which a coalescing caller could grab a settled task.
      this.drainTask = null;
    }
  }

  /**
   * One drain pass: group queued entries by collection, push each group's
   * current document versions, and remove the entries a push accepted. A
   * group whose push throws is left queued for a later pass.
   */
  private async drainOnce(): Promise<void> {
    const entries = await this.adapter.getAll<OutboxDoc>(OUTBOX);
    if (entries.length === 0) return;

    const byCollection = new Map<string, OutboxDoc[]>();
    for (const entry of entries) {
      const group = byCollection.get(entry.collection);
      if (group) group.push(entry);
      else byCollection.set(entry.collection, [entry]);
    }

    let changed = false;
    for (const [collection, group] of byCollection) {
      // Push the docs' *current* versions, coalescing edits made since they were
      // queued. A doc that's vanished locally (hard-deleted before its push
      // landed) has nothing to send, but its entry is still cleared.
      const docs: BaseDocument[] = [];
      for (const entry of group) {
        const doc = await this.adapter.get<BaseDocument>(collection, entry.docId);
        if (doc) docs.push(this.migrator.migrate<BaseDocument>(collection, doc));
      }
      try {
        if (docs.length > 0) await this.syncClient!.push(collection, docs);
        await Promise.all(group.map((entry) => this.adapter.delete(OUTBOX, entry.id)));
        changed = true;
      } catch {
        // Leave this collection's entries queued; a later drain retries them.
      }
    }
    if (changed) this.emit(OUTBOX);
  }

  /** Count of documents written locally but not yet accepted by the server. */
  async pendingPushCount(): Promise<number> {
    const entries = await this.adapter.getAll<OutboxDoc>(OUTBOX);
    return entries.length;
  }

  async pull<T extends BaseDocument>(collection: string): Promise<T[]> {
    if (!this.syncClient) return [];
    const applied: T[] = [];
    // Pull is paged server-side; drain from the stored cursor until the server
    // reports no more pages. Each page's cursor is persisted as it lands, so an
    // interrupted drain (offline, crash) resumes mid-stream instead of
    // restarting the whole collection.
    let cursor = await this.getLastSyncCursor(collection);
    for (;;) {
      const page = await this.syncClient.pull<T>(collection, cursor);
      const upgraded = page.documents.map((doc) => this.migrator.migrate<T>(collection, doc));
      for (const doc of upgraded) {
        const local = await this.adapter.get<T>(collection, doc.id);
        // Last-write-wins: skip an incoming doc that's older than the local
        // copy, so a not-yet-pushed local edit isn't clobbered by a stale
        // server version. Mirrors the server's upsert guard (db.ts); ties go
        // to the incoming doc. The cursor still advances past it — the local
        // copy is newer and will be pushed, so re-pulling the server's is moot.
        if (local && local.updatedAt > doc.updatedAt) continue;
        await this.adapter.put(collection, doc);
        applied.push(doc);
      }
      await this.setLastSyncCursor(collection, page.cursor);
      // hasMore implies a full page, so the cursor strictly advanced; the
      // no-progress check is a backstop against a misbehaving server.
      if (!page.hasMore || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    if (applied.length > 0) this.emit(collection);
    return applied;
  }

  async pullDocument<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    if (!this.syncClient) return null;
    const doc = await this.syncClient.pullDocument<T>(collection, id);
    if (!doc) return null;
    const upgraded = this.migrator.migrate<T>(collection, doc);
    const local = await this.adapter.get<T>(collection, id);
    // Last-write-wins: a newer local edit takes precedence over the pulled
    // server copy (see `pull`). Return the version that's now authoritative.
    if (local && local.updatedAt > upgraded.updatedAt) return local;
    await this.adapter.put(collection, upgraded);
    this.emit(collection);
    return upgraded;
  }

  collection<T extends BaseDocument>(name: string): Collection<T> {
    return new Collection<T>(this, name);
  }

  async getLastSyncedAt(collections: string[]): Promise<Date | null> {
    if (collections.length === 0) return null;
    const metas = await Promise.all(
      collections.map((c) => this.adapter.get<SyncMetaDoc>('_sync_meta', c))
    );
    const times = metas.map((m) => m?.syncedAt).filter((t): t is string => typeof t === 'string');
    if (times.length === 0) return null;
    const latest = times.reduce((a, b) => (a > b ? a : b));
    return dayjs(latest).toDate();
  }

  // The pull cursor is a server-assigned `seq` high-water mark, not a
  // timestamp — see `pull` / the server's db.ts. Stored alongside `syncedAt`
  // (this device's wall clock at last pull) which drives the human-facing
  // "last synced" display only. A client upgrading from the old
  // timestamp-cursor scheme has no `cursor` field yet, so this returns 0 and
  // the collection re-pulls from the start once — which also backfills any
  // writes the old clock-based cursor had skipped.
  private async getLastSyncCursor(collection: string): Promise<number> {
    const meta = await this.adapter.get<SyncMetaDoc>('_sync_meta', collection);
    return meta?.cursor ?? 0;
  }

  private async setLastSyncCursor(collection: string, cursor: number): Promise<void> {
    const authorId = await this.getCurrentAuthor();
    const now = dayjs().toISOString();
    await this.adapter.put<SyncMetaDoc>('_sync_meta', {
      id: collection,
      schemaVersion: this.migrator.currentVersion('_sync_meta'),
      createdAt: now,
      updatedAt: now,
      createdBy: authorId,
      updatedBy: authorId,
      deletedAt: null,
      deletedBy: null,
      cursor,
      syncedAt: now,
    });
  }
}

type SyncMetaDoc = BaseDocument & { cursor: number; syncedAt: string };

// The internal, never-synced collection of pending document pushes. One entry
// per locally-written doc, keyed `${collection}/${docId}`, holding just a
// reference — the drain reads the doc's current version at push time. `_`-prefix
// keeps it out of every sync/pull/push-all path (those skip `_*` collections).
const OUTBOX = '_outbox';
type OutboxDoc = BaseDocument & { collection: string; docId: string };
function outboxKey(collection: string, docId: string): string {
  return `${collection}/${docId}`;
}

export class Collection<T extends BaseDocument> {
  private readonly store: Store;
  private readonly name: string;

  constructor(store: Store, name: string) {
    this.store = store;
    this.name = name;
  }

  get(id: string): Promise<T | null> {
    return this.store.get<T>(this.name, id);
  }
  getMany(ids: string[]): Promise<T[]> {
    return this.store.getMany<T>(this.name, ids);
  }
  list(): Promise<T[]> {
    return this.store.list<T>(this.name);
  }
  create(id: string, input: Omit<T, keyof BaseDocument>): Promise<T> {
    return this.store.create<T>(this.name, id, input);
  }
  update(id: string, input: Partial<Omit<T, keyof BaseDocument>>): Promise<T> {
    return this.store.update<T>(this.name, id, input);
  }
  delete(id: string): Promise<void> {
    return this.store.delete(this.name, id);
  }
  createMany(items: Array<{ id: string } & Omit<T, keyof BaseDocument>>): Promise<T[]> {
    return this.store.createMany<T>(this.name, items);
  }
  updateMany(updates: Array<{ id: string } & Partial<Omit<T, keyof BaseDocument>>>): Promise<T[]> {
    return this.store.updateMany<T>(this.name, updates);
  }
  deleteMany(ids: string[]): Promise<void> {
    return this.store.deleteMany(this.name, ids);
  }
  pull(): Promise<T[]> {
    return this.store.pull<T>(this.name);
  }
  pullDocument(id: string): Promise<T | null> {
    return this.store.pullDocument<T>(this.name, id);
  }
}
