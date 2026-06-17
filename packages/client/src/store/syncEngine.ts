import dayjs from 'dayjs';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BaseDocument } from '../types';
import type { Migrator } from '../migrator';
import { SyncClient } from '../sync/sync';
import { LOCAL_AUTHOR_ID } from '../system';
import {
  OUTBOX,
  outboxKey,
  READ_PULL_THROTTLE_MS,
  type OutboxDoc,
  type SyncMetaDoc,
} from './types';

export interface SyncEngineDeps {
  adapter: DatabaseAdapter;
  migrator: Migrator;
  /** Collections iterated for push-all / pull-all; empty falls back to the adapter. */
  collections: readonly string[];
  /** Live read of the Store's current author id (changes via setAuthor/wipe). */
  getAuthorId: () => string;
  /** Routes a collection-changed signal back through the Store's `change` channel. */
  emit: (collection: string) => void;
}

/**
 * Owns everything that moves documents between local storage and a sync server:
 * the durable push outbox and its drain loop, paged pulls with last-write-wins
 * merge, push-all, and the per-collection pull cursor. Constructed and held by
 * the `Store`, which feeds it live views of its author id and `change` emitter
 * and swaps the `SyncClient` in/out as credentials are registered or cleared.
 */
export class SyncEngine {
  private readonly adapter: DatabaseAdapter;
  private readonly migrator: Migrator;
  private readonly collections: readonly string[];
  private readonly getAuthorId: () => string;
  private readonly emit: (collection: string) => void;

  private syncClient: SyncClient | null = null;
  private readonly lastReadPullAt = new Map<string, number>();
  private readonly inFlightReadPulls = new Set<string>();
  // Coalesces concurrent outbox drains: `drainTask` is the in-flight drain, so
  // callers await the same one; `drainPending` flags that another drain was
  // requested mid-flight, making the runner take one more pass (a write enqueued
  // — or a retry requested — during a drain isn't stranded).
  private drainTask: Promise<void> | null = null;
  private drainPending = false;

  constructor(deps: SyncEngineDeps) {
    this.adapter = deps.adapter;
    this.migrator = deps.migrator;
    this.collections = deps.collections;
    this.getAuthorId = deps.getAuthorId;
    this.emit = deps.emit;
  }

  /** Point the engine at a new sync server, or `null` to go local-only. */
  setSyncClient(client: SyncClient | null): void {
    this.syncClient = client;
  }

  /**
   * Fire-and-forget background pull triggered by a read. A no-op without sync
   * credentials. Deduped while a pull for the collection is in flight and
   * throttled to `READ_PULL_THROTTLE_MS` so re-renders don't spray requests.
   * The applied docs emit `change`, which the UI layer turns into a refetch —
   * and that refetch is throttled out here, so there's no read→pull→read loop.
   */
  triggerReadPull(collection: string): void {
    if (!this.syncClient) return;
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

  async pullRegisteredCollections(): Promise<void> {
    const list =
      this.collections.length > 0 ? this.collections : await this.adapter.listCollections();
    await Promise.all(
      list.filter((c) => !c.startsWith('_')).map((c) => this.pull(c).catch(() => {}))
    );
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
  async queuePush(collection: string, ids: readonly string[]): Promise<void> {
    if (!this.syncClient || ids.length === 0) return;
    const now = dayjs().toISOString();
    const author = this.getAuthorId();
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
    if (this.getAuthorId() === LOCAL_AUTHOR_ID) return;
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
    const authorId = this.getAuthorId();
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
