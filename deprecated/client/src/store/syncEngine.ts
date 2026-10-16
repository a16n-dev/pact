import dayjs from 'dayjs';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BaseDocument } from '../types';
import type { Migrator } from '../migrator';
import type { SyncClient } from '../sync/sync';
import { isEncryptedDoc } from '../crypto/docCrypto';
import { LOCAL_AUTHOR_ID } from '../system';
import {
  OUTBOX,
  outboxKey,
  READ_PULL_THROTTLE_MS,
  type OutboxDoc,
  type SyncMetaDoc,
} from './types';

// The server also rejects `_local`-authored docs, but only when it can read
// the author fields, which it cannot for end-to-end-encrypted docs. This
// client-side filter is the enforcement that survives encryption.
function isLocalAuthored(doc: BaseDocument): boolean {
  return (
    doc.createdBy === LOCAL_AUTHOR_ID ||
    doc.updatedBy === LOCAL_AUTHOR_ID ||
    doc.deletedBy === LOCAL_AUTHOR_ID
  );
}

export interface SyncEngineDeps {
  adapter: DatabaseAdapter;
  // The same adapter stack minus the cipher (identical to `adapter` on
  // unencrypted stores). Reads cleartext base fields such as LWW timestamps,
  // and sees docs sealed under other keys, which the decrypting `adapter`
  // hides in multi-key mode, so they can move through sync intact.
  rawAdapter: DatabaseAdapter;
  migrator: Migrator;
  collections: readonly string[];
  getAuthorId: () => string;
  emit: (collection: string) => void;
  // The Store's write choke point rather than the adapter directly, so
  // derived state maintained off writes (indexes) sees pulled docs too.
  persist: (collection: string, doc: BaseDocument) => Promise<void>;
}

export class SyncEngine {
  private readonly adapter: DatabaseAdapter;
  private readonly rawAdapter: DatabaseAdapter;
  private readonly migrator: Migrator;
  private readonly collections: readonly string[];
  private readonly getAuthorId: () => string;
  private readonly emit: (collection: string) => void;
  private readonly persist: (collection: string, doc: BaseDocument) => Promise<void>;

  private syncClient: SyncClient | null = null;
  private readonly lastReadPullAt = new Map<string, number>();
  private readonly inFlightReadPulls = new Set<string>();
  // Concurrent drains coalesce onto `drainTask`; `drainPending` makes the
  // runner take one more pass when a drain was requested mid-flight, so a
  // write enqueued during a drain is not stranded.
  private drainTask: Promise<void> | null = null;
  private drainPending = false;

  constructor(deps: SyncEngineDeps) {
    this.adapter = deps.adapter;
    this.rawAdapter = deps.rawAdapter;
    this.migrator = deps.migrator;
    this.collections = deps.collections;
    this.getAuthorId = deps.getAuthorId;
    this.emit = deps.emit;
    this.persist = deps.persist;
  }

  setSyncClient(client: SyncClient | null): void {
    this.syncClient = client;
  }

  // Applied docs emit `change`, which the UI turns into a refetch; the
  // throttle swallows that refetch's pull, so there is no read-pull-read loop.
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
    await Promise.all(this.collections.map((c) => this.pull(c).catch(() => {})));
  }

  async pushAll(): Promise<void> {
    if (!this.syncClient) return;
    for (const collection of this.collections) {
      const readable = await this.adapter.getAll<BaseDocument>(collection);
      const docs = readable
        .map((doc) => this.migrator.migrate<BaseDocument>(collection, doc))
        .filter((doc) => !isLocalAuthored(doc));
      // Rows sealed under other keys are invisible to the decrypting read but
      // must still reach the server (e.g. restored from a backup on a device
      // registered under a different key). The wire transform passes an
      // already-sealed envelope through unchanged.
      if (this.rawAdapter !== this.adapter) {
        const readableIds = new Set(readable.map((doc) => doc.id));
        for (const row of await this.rawAdapter.getAll<BaseDocument>(collection)) {
          if (isEncryptedDoc(row) && !readableIds.has(row.id) && !isLocalAuthored(row)) {
            docs.push(row);
          }
        }
      }
      if (docs.length > 0) {
        await this.syncClient.push(collection, docs);
      }
    }
  }

  // The entry is written to local storage before any network call, so a push
  // that fails (offline, server error, app killed mid-flight) is retried on
  // the next drain rather than lost. A purely local store has nowhere to push
  // and must not accumulate a queue.
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
    // Keyed by collection+id, so re-editing a pending doc overwrites its
    // entry instead of queuing a duplicate.
    if (this.adapter.putMany) await this.adapter.putMany(OUTBOX, entries);
    else for (const entry of entries) await this.adapter.put(OUTBOX, entry);
    this.emit(OUTBOX);
    void this.drainOutbox().catch(() => {});
  }

  async drainOutbox(): Promise<void> {
    if (!this.syncClient) return;
    // The server rejects pre-identity writes; leave them queued for the claim
    // flow to push once an author is assigned.
    if (this.getAuthorId() === LOCAL_AUTHOR_ID) return;
    // Set the flag before checking for an in-flight drain so that drain takes
    // another pass, and await the same task so a coalesced caller still
    // observes a settled drain. The window between the loop's last
    // `drainPending` check and clearing `drainTask` is synchronous, so no
    // request slips through unobserved.
    this.drainPending = true;
    if (!this.drainTask) this.drainTask = this.runDrain();
    return this.drainTask;
  }

  private async runDrain(): Promise<void> {
    try {
      // A failed pass leaves its entries queued and, absent a new request,
      // exits rather than spinning while offline.
      while (this.drainPending) {
        this.drainPending = false;
        await this.drainOnce();
      }
    } finally {
      // Must clear in the same synchronous continuation as the loop's exit;
      // see `drainOutbox`.
      this.drainTask = null;
    }
  }

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
      // Pushes each doc's current version, coalescing edits made since it was
      // queued. A doc hard-deleted before its push landed has nothing to send
      // but its entry is still cleared; a doc still `_local`-authored keeps
      // its entry until the claim flow reassigns it.
      const docs: BaseDocument[] = [];
      const clearable: OutboxDoc[] = [];
      for (const entry of group) {
        const doc = await this.adapter.get<BaseDocument>(collection, entry.docId);
        if (!doc) {
          // The row may exist but be sealed under another key (e.g. queued
          // before an identity claim, then superseded by a pulled foreign
          // version). Push the envelope verbatim rather than treating the
          // doc as vanished.
          const raw = await this.rawAdapter.get<BaseDocument>(collection, entry.docId);
          if (raw && isEncryptedDoc(raw)) {
            if (isLocalAuthored(raw)) continue;
            docs.push(raw);
          }
          clearable.push(entry);
          continue;
        }
        const migrated = this.migrator.migrate<BaseDocument>(collection, doc);
        if (isLocalAuthored(migrated)) continue;
        docs.push(migrated);
        clearable.push(entry);
      }
      try {
        if (docs.length > 0) await this.syncClient!.push(collection, docs);
        await Promise.all(clearable.map((entry) => this.adapter.delete(OUTBOX, entry.id)));
        changed = clearable.length > 0;
      } catch {
        // Entries stay queued for a later drain.
      }
    }
    if (changed) this.emit(OUTBOX);
  }

  async pendingPushCount(): Promise<number> {
    const entries = await this.adapter.getAll<OutboxDoc>(OUTBOX);
    return entries.length;
  }

  async pull<T extends BaseDocument>(collection: string): Promise<T[]> {
    if (!this.syncClient) return [];
    const applied: T[] = [];
    // Each page's cursor is persisted as it lands, so an interrupted pull
    // resumes mid-stream instead of restarting the collection.
    let cursor = await this.getLastSyncCursor(collection);
    for (;;) {
      const page = await this.syncClient.pull<T>(collection, cursor);
      for (const wireDoc of page.documents) {
        // Last-write-wins, mirroring the server's upsert guard: a strictly
        // newer local copy wins, ties go to the incoming doc. The cursor
        // still advances past a skipped doc since the local copy will be
        // pushed anyway. The raw read is enough (`updatedAt` is cleartext on
        // envelopes) and also sees local rows sealed under other keys.
        //
        // A doc still sealed after the wire transform belongs to another key
        // (multi-key mode): store the envelope raw, since ciphertext cannot
        // be migrated, validated, or indexed, so it surfaces on a device
        // holding its key. It is invisible here, so it is not applied.
        if (isEncryptedDoc(wireDoc)) {
          const local = await this.rawAdapter.get<BaseDocument>(collection, wireDoc.id);
          if (local && local.updatedAt > wireDoc.updatedAt) continue;
          await this.rawAdapter.put(collection, wireDoc);
          continue;
        }
        const doc = this.migrator.migrate<T>(collection, wireDoc);
        const local = await this.rawAdapter.get<BaseDocument>(collection, doc.id);
        if (local && local.updatedAt > doc.updatedAt) continue;
        await this.persist(collection, doc);
        applied.push(doc);
      }
      await this.setLastSyncCursor(collection, page.cursor);
      // The no-progress check is a backstop against a misbehaving server.
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
    // Another key's doc: store the envelope raw and report it as missing,
    // as in `pull`.
    if (isEncryptedDoc(doc)) {
      const localRaw = await this.rawAdapter.get<BaseDocument>(collection, id);
      if (!localRaw || localRaw.updatedAt <= doc.updatedAt) {
        await this.rawAdapter.put(collection, doc);
      }
      return null;
    }
    const upgraded = this.migrator.migrate<T>(collection, doc);
    const local = await this.rawAdapter.get<BaseDocument>(collection, id);
    if (local && local.updatedAt > upgraded.updatedAt) {
      // The raw row carries only base fields when encrypted, so return the
      // decrypted local copy.
      return this.adapter.get<T>(collection, id);
    }
    await this.persist(collection, upgraded);
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

  // A client upgrading from the old timestamp-cursor scheme has no `cursor`
  // field, so it re-pulls from 0 once, which also backfills any writes the
  // clock-based cursor had skipped.
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
