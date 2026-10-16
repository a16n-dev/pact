import type { DatabaseAdapter } from '../adapters/adapter';
import type { CollectionDefinition } from '../collection';
import { ClockDriftError, type HybridClock } from '../clock';
import type { RecordCodec } from '../crypto/codec';
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
  type WireDocument,
  type WireVersion,
} from './http';
import { codeChallenge, randomUrlSafe } from './pkce';
import { RealtimeConnection } from './realtime';

// Reads fire on every render that touches a hook, so without a floor a busy
// screen would spray pulls. Realtime and foreground sync cover the gaps.
const READ_PULL_THROTTLE_MS = 10_000;

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

/** What the engine needs from the store; the store owns records, the engine owns the session and cursor. */
export type SyncStoreAccess = {
  adapter: DatabaseAdapter;
  codec: RecordCodec;
  clock: HybridClock;
  node: string;
  syncedDefinitions: readonly CollectionDefinition[];
  definitionByKey(key: string): CollectionDefinition | undefined;
  definitionByName(name: string): CollectionDefinition | undefined;
  applyIncoming(def: CollectionDefinition, id: string, record: StoredRecord): Promise<ApplyResult>;
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
          await this.guarded(async (http) => {
            await this.backfill(http, total);
            await this.pullAll(http, total);
          });
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

  // A collection defined after this install first synced has versions below
  // the cursor; it is caught up on its own before the store-wide loop runs.
  // A store that has never pulled covers every collection from cursor 0.
  private async backfill(http: SyncHttp, total: PullResult): Promise<void> {
    const pulled = new Set(
      (await this.getConfig<{ keys: string[] }>('pulledCollections'))?.keys ?? []
    );
    const keys = this.store.syncedDefinitions.map((d) => d.key);
    const missing = keys.filter((key) => !pulled.has(key));
    if (missing.length === 0) return;
    const cursor = (await this.getConfig<{ cursor: number }>('cursor'))?.cursor ?? 0;
    if (cursor > 0) {
      for (const key of missing) {
        let at = 0;
        for (;;) {
          const page = await http.pull(at, key);
          await this.applyVersions(page.documents, total);
          if (!page.hasMore || page.cursor === at) break;
          at = page.cursor;
        }
        pulled.add(key);
        await this.setConfig('pulledCollections', { keys: Array.from(pulled) });
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
      if (!page.hasMore || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    await this.setConfig('lastSyncedAt', { at: new Date().toISOString() });
  }

  private async applyVersions(
    versions: readonly WireVersion[],
    total: PullResult
  ): Promise<Set<string>> {
    const touched = new Set<string>();
    for (const version of versions) {
      const def = this.store.definitionByKey(version.collection);
      if (!def || !def.synced) continue;
      try {
        this.store.clock.receive(version.hlc);
      } catch (err) {
        if (!(err instanceof ClockDriftError)) throw err;
        total.skipped.drift += 1;
        continue;
      }
      const record = await this.store.codec.fromWire(def.key, version.id, version.data);
      if (!record) {
        total.skipped.sealed += 1;
        continue;
      }
      const result = await this.store.applyIncoming(def, version.id, record);
      if (result === 'held') total.held += 1;
      if (result === 'applied') {
        total.applied += 1;
        touched.add(def.name);
      }
    }
    for (const name of touched) this.store.emit(name);
    return touched;
  }

  async pullDocument(collection: string, id: string): Promise<void> {
    const def = this.store.definitionByName(collection);
    if (!def) throw new Error(`Unknown collection "${collection}"`);
    await this.guarded(async (http) => {
      const versions = await http.pullDocument(def.key, id);
      await this.applyVersions(versions, { applied: 0, skipped: { drift: 0, sealed: 0 }, held: 0 });
    });
  }

  async resync(): Promise<PullResult> {
    await this.store.clearLocalData();
    await this.setConfig('cursor', { cursor: 0 });
    await this.store.adapter.delete(CONFIG, 'pulledCollections');
    return this.pull();
  }

  async lastSyncedAt(): Promise<Date | null> {
    const at = (await this.getConfig<{ at: string }>('lastSyncedAt'))?.at;
    return at ? new Date(at) : null;
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

  private wireDocument(key: string, id: string, stored: AdapterRecord): WireDocument {
    const hlc = isSealedRecord(stored) ? stored.hlc : (greatestClock(stored) ?? '');
    return { collection: key, id, hlc, data: this.store.codec.toWire(stored) };
  }

  // Pushes each document's current state, coalescing edits made since it was
  // queued. A failed chunk stops the drain with its entries and all later ones
  // still queued.
  private async drainOnce(http: SyncHttp): Promise<void> {
    const entries = await this.outboxEntries();
    if (entries.length === 0) return;
    const documents: WireDocument[] = [];
    const keys: string[] = [];
    const stale: string[] = [];
    for (const { key, entry } of entries) {
      const def = this.store.definitionByName(entry.collection);
      const stored = def ? await this.store.adapter.get(def.key, entry.docId) : null;
      if (!def || !stored) {
        stale.push(key);
        continue;
      }
      documents.push(this.wireDocument(def.key, entry.docId, stored));
      keys.push(key);
    }
    for (const key of stale) await this.store.adapter.delete(OUTBOX, key);
    for (let i = 0; i < documents.length; i += this.maxPushDocuments) {
      await http.push(documents.slice(i, i + this.maxPushDocuments));
      for (const key of keys.slice(i, i + this.maxPushDocuments)) {
        await this.store.adapter.delete(OUTBOX, key);
      }
    }
    if (stale.length > 0 || keys.length > 0) this.store.emit(OUTBOX);
  }

  async push(): Promise<void> {
    await this.drain();
    await this.guarded(async (http) => {
      const documents: WireDocument[] = [];
      const live = new Set<string>();
      for (const def of this.store.syncedDefinitions) {
        for (const { id, record } of await this.store.adapter.getAll(def.key)) {
          documents.push(this.wireDocument(def.key, id, record));
          live.add(`${def.key}/${id}`);
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
