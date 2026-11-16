import type { DatabaseAdapter } from '../adapters/adapter';
import type { CollectionDefinition } from '../collection';
import { ClockDriftError, type HybridClock } from '../clock';
import { toWire, type RecordCodec } from '../crypto/codec';
import { greatestClock, isSealedRecord, type AdapterRecord, type StoredRecord } from '../record';
import { CONFIG, OUTBOX, configRecord, type OutboxEntry } from '../store/internal';
import type {
  PullResult,
  Registration,
  Session,
  SignInResult,
  SignInStart,
} from '../store/namespaces';
import {
  SyncHttp,
  UnauthorizedError,
  discover,
  exchangeCode,
  type PushDocument,
  type PushResponse,
  type TaskClaim,
  type WireVersion,
} from './http';
import { codeChallenge, randomUrlSafe } from './pkce';
import { RealtimeConnection } from './realtime';

// Reads fire on every render that touches a hook, so without a floor a busy
// screen would spray pulls. Realtime and foreground sync cover the gaps.
const READ_PULL_THROTTLE_MS = 10_000;

// Each refusal means another device's version reached the server first, so
// a drain retries a few times and then leaves the rest for the next one.
const MAX_REFUSED_ROUNDS = 3;

type ClientConfig = {
  url: string;
  appId: string;
  deviceId: string;
  deviceName: string;
  token: string | null;
  maxPushDocuments: number;
};

type PendingSignIn = {
  url: string;
  appId: string;
  deviceName: string;
  redirectUri: string;
  state: string;
  verifier: string;
  tokenUrl: string;
  maxPushDocuments: number;
};

export type HeldEntry = { collection: string; docId: string; data: AdapterRecord };

export type ApplyResult = 'applied' | 'unchanged' | 'held';

// `compaction` marks a new generation this device made and the server has
// not yet confirmed.
export type PushGeneration = { generation: number; compaction: boolean };

// What the engine needs from the store; the store owns records and the
// active lens, the engine owns the session and cursor. Keys here are storage
// keys, which carry the lens (`notes@<keyId>`).
export type SyncStoreAccess = {
  adapter: DatabaseAdapter;
  codec(): RecordCodec;
  clock: HybridClock;
  node: string;
  // The synced storage keys of the active lens.
  activeKeys(): string[];
  // The definition behind a synced key of the active lens.
  activeDefinition(key: string): CollectionDefinition | undefined;
  activeKeyOf(name: string): string | undefined;
  // The collection's key outside any lens, for entries queued before lenses.
  plainKeyOf(name: string): string | undefined;
  isSyncedKey(key: string): boolean;
  // Every stored synced key, in any lens.
  storedSyncedKeys(): Promise<string[]>;
  // `seq` is the version's place on the server; versions arrive in `seq` order.
  applyIncoming(
    def: CollectionDefinition,
    id: string,
    record: StoredRecord,
    seq: number
  ): Promise<ApplyResult>;
  // Deletes the outbox entry at `key` only if it is still `entry`: a write
  // since the drain read it requeued it, and that newer state still needs
  // pushing. `pushed` is the state the drain sent and `seq` the push's,
  // both absent for a stale entry.
  clearQueued(key: string, entry: OutboxEntry, pushed?: AdapterRecord, seq?: number): Promise<void>;
  // The generation a push of `stored` carries; absent outside the active lens
  // and for collections without text.
  pushGeneration(
    key: string,
    id: string,
    stored: AdapterRecord
  ): Promise<PushGeneration | undefined>;
  // Every version up to `cursor` has been applied.
  pulledThrough(cursor: number): Promise<void>;
  heldEntries(): Promise<HeldEntry[]>;
  /** Everything but `_config`, for `resync()`. */
  clearLocalData(): Promise<void>;
  emit(collection: string): void;
  emitSignedOut(): void;
};

export class SyncEngine {
  private readonly store: SyncStoreAccess;
  private http: SyncHttp | null = null;
  private maxPushDocuments = 50;
  private realtime: RealtimeConnection | null = null;
  private lastReadPullAt = 0;
  // Concurrent pulls and drains each coalesce onto one task; a request made
  // mid-flight makes the runner take one more pass, so nothing is stranded.
  private pullTask: Promise<PullResult> | null = null;
  private pullPending = false;
  // Set while the store switches lens; a pull pass never straddles a switch.
  private pullGate: Promise<void> | null = null;
  private readonly passes = new Set<Promise<void>>();
  private drainTask: Promise<void> | null = null;
  private drainPending = false;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(store: SyncStoreAccess) {
    this.store = store;
  }

  /** Loads the persisted session so sync calls work at once; no network. */
  async restore(): Promise<void> {
    const client = await this.getConfig<ClientConfig>('client');
    if (client?.token) this.connect({ ...client, token: client.token });
  }

  /** Validates the restored token, then opens realtime. */
  async start(): Promise<void> {
    const client = await this.getConfig<ClientConfig>('client');
    const token = client?.token;
    if (!client || !token || !this.http) return;
    try {
      await this.http.check();
    } catch (err) {
      if (err instanceof UnauthorizedError) await this.handleSignedOut();
      // Offline at boot: realtime's reconnect loop takes over.
      return;
    }
    this.openRealtime({ ...client, token });
  }

  stop(): void {
    this.realtime?.stop();
    this.realtime = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  private connect(client: ClientConfig & { token: string }): void {
    this.http = new SyncHttp(client.url, client.token);
    this.maxPushDocuments = client.maxPushDocuments;
  }

  private openRealtime(client: ClientConfig & { token: string }): void {
    this.realtime?.stop();
    this.realtime = new RealtimeConnection({
      url: client.url,
      token: client.token,
      onOpen: () => {
        void this.pull()
          .catch(() => {})
          .then(() => this.drain().catch(() => {}));
      },
      onChanged: (seq) => {
        void this.getConfig<{ cursor: number }>('cursor').then((c) => {
          if ((c?.cursor ?? 0) !== seq) void this.pull().catch(() => {});
        });
      },
      onSignedOut: () => void this.handleSignedOut(),
    });
    this.realtime.start();
  }

  async beginSignIn(start: SignInStart): Promise<{ authorizeUrl: string; state: string }> {
    const url = start.url.replace(/\/+$/, '');
    const discovery = await discover(url);
    const verifier = randomUrlSafe(48);
    const state = randomUrlSafe(24);
    const pending: PendingSignIn = {
      url,
      appId: start.appId,
      deviceName: start.deviceName,
      redirectUri: start.redirectUri,
      state,
      verifier,
      tokenUrl: discovery.tokenUrl,
      maxPushDocuments: discovery.maxPushDocuments,
    };
    await this.setConfig('signIn', pending);
    const params = new URLSearchParams({
      app_id: start.appId,
      redirect_uri: start.redirectUri,
      device_id: this.store.node,
      device_name: start.deviceName,
      state,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return { authorizeUrl: `${discovery.authorizeUrl}?${params}`, state };
  }

  async completeSignIn(input: { code: string; state: string }): Promise<SignInResult> {
    const pending = await this.getConfig<PendingSignIn>('signIn');
    if (!pending || pending.state !== input.state) return { ok: false, reason: 'state' };
    const result = await exchangeCode({
      tokenUrl: pending.tokenUrl,
      code: input.code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      appId: pending.appId,
    });
    if (!result.ok) return result;
    const client: ClientConfig = {
      url: pending.url,
      appId: pending.appId,
      deviceId: this.store.node,
      deviceName: pending.deviceName,
      token: result.token,
      maxPushDocuments: pending.maxPushDocuments,
    };
    await this.setConfig('client', client);
    await this.store.adapter.delete(CONFIG, 'signIn');
    this.connect({ ...client, token: result.token });
    this.openRealtime({ ...client, token: result.token });
    return { ok: true };
  }

  async signOut(): Promise<void> {
    const http = this.http;
    if (!http) return;
    try {
      await http.signOut();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }
    await this.forgetToken();
  }

  async session(): Promise<Session | null> {
    if (!this.http) return null;
    try {
      return await this.http.check();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await this.handleSignedOut();
        return null;
      }
      throw err;
    }
  }

  async registration(): Promise<Registration | null> {
    const client = await this.getConfig<ClientConfig>('client');
    if (!client) return null;
    const { url, appId, deviceId, deviceName } = client;
    return { url, appId, deviceId, deviceName };
  }

  async credentials(): Promise<{ url: string; token: string } | null> {
    const client = await this.getConfig<ClientConfig>('client');
    return client?.token ? { url: client.url, token: client.token } : null;
  }

  /** Any 401, or a signed-out realtime close, lands here: the token is gone for good. */
  async handleSignedOut(): Promise<void> {
    if (!this.http) return;
    await this.forgetToken();
    this.store.emitSignedOut();
  }

  private async forgetToken(): Promise<void> {
    this.http = null;
    this.realtime?.stop();
    this.realtime = null;
    const client = await this.getConfig<ClientConfig>('client');
    if (client) await this.setConfig('client', { ...client, token: null });
  }

  requestPull(): void {
    if (this.http) void this.pull().catch(() => {});
  }

  triggerReadPull(): void {
    if (!this.http) return;
    const now = Date.now();
    if (now - this.lastReadPullAt < READ_PULL_THROTTLE_MS) return;
    this.lastReadPullAt = now;
    void this.pull().catch(() => {});
  }

  pull(): Promise<PullResult> {
    this.pullPending = true;
    if (!this.pullTask) this.pullTask = this.runPulls();
    return this.pullTask;
  }

  // A pass that fails while another request is pending runs again instead
  // of failing, so a caller who joined mid-flight sees an attempt made after
  // their request.
  private async runPulls(): Promise<PullResult> {
    const total: PullResult = { applied: 0, skipped: { drift: 0, sealed: 0 }, held: 0 };
    try {
      for (;;) {
        this.pullPending = false;
        try {
          await this.pass(() =>
            this.guarded(async (http) => {
              await this.backfill(http, total);
              await this.pullAll(http, total);
            })
          );
        } catch (err) {
          if (!this.pullPending) throw err;
          continue;
        }
        if (!this.pullPending) return total;
      }
    } finally {
      this.pullTask = null;
    }
  }

  // Anything that applies pulled versions runs as a pass, so it resolves the
  // lens and writes into it without a switch in between.
  private async pass<T>(work: () => Promise<T>): Promise<T> {
    while (this.pullGate) await this.pullGate;
    const running = work();
    const settled = running.then(
      () => undefined,
      () => undefined
    );
    this.passes.add(settled);
    void settled.then(() => this.passes.delete(settled));
    return running;
  }

  // Waits out the passes in flight and holds back new ones until the returned release runs.
  async pausePulls(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.pullGate = gate;
    await Promise.all(this.passes);
    return () => {
      if (this.pullGate === gate) this.pullGate = null;
      release();
    };
  }

  // The store-wide pull skips versions outside the active lens, so a lens
  // being left is caught up from the current cursor when it is next active.
  async leaveLens(keys: readonly string[]): Promise<void> {
    const pulled = new Set(
      (await this.getConfig<{ keys: string[] }>('pulledCollections'))?.keys ?? []
    );
    const cursor = (await this.getConfig<{ cursor: number }>('cursor'))?.cursor ?? 0;
    const resume = await this.resumeCursors();
    for (const key of keys) {
      if (!pulled.delete(key)) continue;
      resume[key] = cursor;
    }
    await this.setConfig('pulledCollections', { keys: Array.from(pulled) });
    await this.setConfig('resumeCursors', { cursors: resume });
  }

  private async resumeCursors(): Promise<Record<string, number>> {
    return (
      (await this.getConfig<{ cursors: Record<string, number> }>('resumeCursors'))?.cursors ?? {}
    );
  }

  // Routes a 401 from any request into the signed-out handling.
  private async guarded<T>(task: (http: SyncHttp) => Promise<T>): Promise<T> {
    const http = this.http;
    if (!http) throw new Error('Not signed in');
    try {
      return await task(http);
    } catch (err) {
      if (err instanceof UnauthorizedError) await this.handleSignedOut();
      throw err;
    }
  }

  // A collection defined after this install first synced, or one in a lens
  // that was not active, has versions below the cursor; it is caught up on its
  // own before the store-wide loop runs, from where it left off if it was
  // left. A store that has never pulled covers every collection from cursor 0.
  private async backfill(http: SyncHttp, total: PullResult): Promise<void> {
    const pulled = new Set(
      (await this.getConfig<{ keys: string[] }>('pulledCollections'))?.keys ?? []
    );
    const keys = this.store.activeKeys();
    const missing = keys.filter((key) => !pulled.has(key));
    if (missing.length === 0) return;
    const cursor = (await this.getConfig<{ cursor: number }>('cursor'))?.cursor ?? 0;
    if (cursor > 0) {
      const resume = await this.resumeCursors();
      for (const key of missing) {
        let at = resume[key] ?? 0;
        for (;;) {
          const page = await http.pull(at, key);
          await this.applyVersions(page.documents, total);
          if (!page.hasMore || page.cursor === at) break;
          at = page.cursor;
        }
        pulled.add(key);
        delete resume[key];
        await this.setConfig('pulledCollections', { keys: Array.from(pulled) });
        await this.setConfig('resumeCursors', { cursors: resume });
      }
      return;
    }
    await this.setConfig('pulledCollections', { keys });
  }

  private async pullAll(http: SyncHttp, total: PullResult): Promise<void> {
    let cursor = (await this.getConfig<{ cursor: number }>('cursor'))?.cursor ?? 0;
    for (;;) {
      const page = await http.pull(cursor);
      await this.applyVersions(page.documents, total);
      await this.setConfig('cursor', { cursor: page.cursor });
      await this.store.pulledThrough(page.cursor);
      if (!page.hasMore || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    await this.setConfig('lastSyncedAt', { at: new Date().toISOString() });
  }

  // Returns the seqs of the versions it could not merge.
  private async applyVersions(
    versions: readonly WireVersion[],
    total: PullResult
  ): Promise<number[]> {
    const touched = new Set<string>();
    const unmerged: number[] = [];
    for (const version of versions) {
      const def = this.store.activeDefinition(version.collection);
      if (!def) continue;
      try {
        this.store.clock.receive(version.hlc);
      } catch (err) {
        if (!(err instanceof ClockDriftError)) throw err;
        total.skipped.drift += 1;
        unmerged.push(version.seq);
        continue;
      }
      const record = await this.store
        .codec()
        .fromWire(version.collection, version.id, version.data);
      if (!record) {
        total.skipped.sealed += 1;
        unmerged.push(version.seq);
        continue;
      }
      const result = await this.store.applyIncoming(def, version.id, record, version.seq);
      if (result === 'held') {
        total.held += 1;
        unmerged.push(version.seq);
      }
      if (result === 'applied') {
        total.applied += 1;
        touched.add(def.name);
      }
    }
    for (const name of touched) this.store.emit(name);
    return unmerged;
  }

  claimTask(taskId: string, rev: string): Promise<TaskClaim> {
    return this.guarded((http) => http.claimTask(taskId, rev));
  }

  releaseTask(taskId: string, rev: string): Promise<void> {
    return this.guarded((http) => http.releaseTask(taskId, rev));
  }

  async pullDocument(collection: string, id: string): Promise<void> {
    await this.pass(async () => {
      const key = this.store.activeKeyOf(collection);
      if (!key) throw new Error(`Unknown collection "${collection}"`);
      await this.guarded(async (http) => {
        await this.applyDocument(http, key, id);
      });
    });
  }

  // Returns the highest seq up to which every version of the document is merged.
  private async applyDocument(http: SyncHttp, key: string, id: string): Promise<number> {
    const versions = await http.pullDocument(key, id);
    const total = { applied: 0, skipped: { drift: 0, sealed: 0 }, held: 0 };
    const unmerged = await this.applyVersions(versions, total);
    if (unmerged.length > 0) return Math.min(...unmerged) - 1;
    return Math.max(0, ...versions.map((version) => version.seq));
  }

  async resync(): Promise<PullResult> {
    await this.store.clearLocalData();
    await this.setConfig('cursor', { cursor: 0 });
    await this.store.adapter.delete(CONFIG, 'pulledCollections');
    await this.store.adapter.delete(CONFIG, 'resumeCursors');
    return this.pull();
  }

  async lastSyncedAt(): Promise<Date | null> {
    const at = (await this.getConfig<{ at: string }>('lastSyncedAt'))?.at;
    return at ? new Date(at) : null;
  }

  get signedIn(): boolean {
    return this.http !== null;
  }

  /** A debounced request coalesces per `key`, which is how text edits avoid a push per keystroke. */
  requestDrain(debounce?: { key: string; delayMs: number }): void {
    if (!this.http) return;
    if (!debounce) {
      void this.drain().catch(() => {});
      return;
    }
    const existing = this.debounceTimers.get(debounce.key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      debounce.key,
      setTimeout(() => {
        this.debounceTimers.delete(debounce.key);
        void this.drain().catch(() => {});
      }, debounce.delayMs)
    );
  }

  drain(): Promise<void> {
    if (!this.http) return Promise.resolve();
    this.drainPending = true;
    if (!this.drainTask) this.drainTask = this.runDrains();
    return this.drainTask;
  }

  private async runDrains(): Promise<void> {
    try {
      for (;;) {
        this.drainPending = false;
        try {
          await this.guarded((http) => this.drainOnce(http));
        } catch (err) {
          if (!this.drainPending) throw err;
          continue;
        }
        if (!this.drainPending) return;
      }
    } finally {
      this.drainTask = null;
    }
  }

  private async outboxEntries(): Promise<Array<{ key: string; entry: OutboxEntry }>> {
    const rows = await this.store.adapter.getAll(OUTBOX);
    const entries = rows.flatMap(({ id, record }) =>
      isSealedRecord(record) ? [] : [{ key: id, entry: record.fields as unknown as OutboxEntry }]
    );
    return entries.sort((a, b) => (a.entry.order < b.entry.order ? -1 : 1));
  }

  private wireDocument(key: string, id: string, stored: AdapterRecord): PushDocument {
    const hlc = isSealedRecord(stored) ? stored.hlc : (greatestClock(stored) ?? '');
    return { collection: key, id, hlc, data: toWire(stored) };
  }

  // A document the server refuses stays queued and is pulled again before the
  // next round. The pull brings the version it was refused over: a newer
  // generation, onto which this device's edits are replayed, or a version a
  // compaction missed, which the compaction then takes in.
  private async drainOnce(http: SyncHttp): Promise<void> {
    for (let round = 1; ; round++) {
      const refused = await this.pushQueued(http);
      if (refused.length === 0 || round === MAX_REFUSED_ROUNDS) return;
      for (const { collection, id } of refused) {
        await this.pass(() => this.applyDocument(http, collection, id));
      }
    }
  }

  private async queuedState(
    entry: OutboxEntry
  ): Promise<{ storageKey: string; stored: AdapterRecord } | null> {
    const storageKey = entry.key ?? this.store.plainKeyOf(entry.collection);
    if (!storageKey || !this.store.isSyncedKey(storageKey)) return null;
    const stored = await this.store.adapter.get(storageKey, entry.docId);
    return stored && { storageKey, stored };
  }

  // A compaction must include every version on the server, so each document
  // carrying one is pulled first, and the push tells the server how far that
  // pull merged.
  private async seenSeqs(http: SyncHttp): Promise<Map<string, number>> {
    const seen = new Map<string, number>();
    for (const { key, entry } of await this.outboxEntries()) {
      const state = await this.queuedState(entry);
      if (!state) continue;
      const generation = await this.store.pushGeneration(
        state.storageKey,
        entry.docId,
        state.stored
      );
      if (!generation?.compaction) continue;
      seen.set(key, await this.pass(() => this.applyDocument(http, state.storageKey, entry.docId)));
    }
    return seen;
  }

  // Pushes each document's current state, coalescing edits made since it was
  // queued. A failed chunk stops the drain with its entries and all later ones
  // still queued.
  private async pushQueued(http: SyncHttp): Promise<PushResponse['rejected']> {
    const seen = await this.seenSeqs(http);
    const documents: PushDocument[] = [];
    const pushed: Array<{ key: string; entry: OutboxEntry; stored: AdapterRecord }> = [];
    const stale: Array<{ key: string; entry: OutboxEntry }> = [];
    for (const { key, entry } of await this.outboxEntries()) {
      const state = await this.queuedState(entry);
      if (!state) {
        stale.push({ key, entry });
        continue;
      }
      const { storageKey, stored } = state;
      const generation = await this.store.pushGeneration(storageKey, entry.docId, stored);
      const seenSeq = seen.get(key);
      // A compaction made since the pulls above waits for the next round.
      if (generation?.compaction && seenSeq === undefined) continue;
      documents.push({
        ...this.wireDocument(storageKey, entry.docId, stored),
        ...(generation && { generation: generation.generation }),
        ...(generation?.compaction && { seenSeq }),
      });
      pushed.push({ key, entry, stored });
    }
    for (const { key, entry } of stale) await this.store.clearQueued(key, entry);
    const refused: PushResponse['rejected'] = [];
    for (let i = 0; i < documents.length; i += this.maxPushDocuments) {
      const { seq, rejected } = await http.push(documents.slice(i, i + this.maxPushDocuments));
      const accepted = pushed
        .slice(i, i + this.maxPushDocuments)
        .filter(
          (_, j) =>
            !rejected.some(
              (r) => r.collection === documents[i + j]!.collection && r.id === documents[i + j]!.id
            )
        );
      for (const { key, entry, stored } of accepted) {
        await this.store.clearQueued(key, entry, stored, seq);
      }
      refused.push(...rejected);
    }
    if (stale.length > 0 || pushed.length > 0) this.store.emit(OUTBOX);
    return refused;
  }

  // Refusals are left to the drain, which has already run for the queued
  // documents and owns any compaction still waiting for the server.
  async push(): Promise<void> {
    await this.drain();
    await this.guarded(async (http) => {
      const documents: PushDocument[] = [];
      const live = new Set<string>();
      for (const key of await this.store.storedSyncedKeys()) {
        for (const { id, record } of await this.store.adapter.getAll(key)) {
          live.add(`${key}/${id}`);
          const generation = await this.store.pushGeneration(key, id, record);
          if (generation?.compaction) continue;
          documents.push({
            ...this.wireDocument(key, id, record),
            ...(generation && { generation: generation.generation }),
          });
        }
      }
      // A held version is re-sent so a key rotation reseals it; one with a live
      // local record is skipped, since the server keeps one version per writer.
      for (const held of await this.store.heldEntries()) {
        if (live.has(`${held.collection}/${held.docId}`)) continue;
        documents.push(this.wireDocument(held.collection, held.docId, held.data));
      }
      for (let i = 0; i < documents.length; i += this.maxPushDocuments) {
        await http.push(documents.slice(i, i + this.maxPushDocuments));
      }
    });
  }

  async pending(): Promise<number> {
    return (await this.store.adapter.getAll(OUTBOX)).length;
  }

  private async getConfig<T extends Record<string, unknown>>(id: string): Promise<T | null> {
    const raw = await this.store.adapter.get(CONFIG, id);
    if (!raw || isSealedRecord(raw)) return null;
    const { id: _id, createdAt: _createdAt, ...value } = raw.fields;
    return value as T;
  }

  private async setConfig(id: string, value: Record<string, unknown>): Promise<void> {
    await this.store.adapter.put(CONFIG, id, configRecord(id, value));
  }
}
