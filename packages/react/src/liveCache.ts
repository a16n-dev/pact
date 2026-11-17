import type { Store } from '@a16n/pact-client';

const CHANGE_BATCH_DELAY_MS = 50;
// After its last subscriber leaves, so a remount soon after reuses the result.
const UNSUBSCRIBED_ENTRY_TTL_MS = 1_000;
// A render that has not committed yet holds entries no one has subscribed to;
// Suspense can hold it back while later reads load, so this is generous, and
// it still bounds an abandoned render.
const NEVER_SUBSCRIBED_ENTRY_TTL_MS = 60_000;

type LiveSnapshot<T> = { status: 'ok'; value: T } | { status: 'error'; error: unknown };

// React's `use` returns at once for a promise marked fulfilled this way,
// instead of suspending for a tick on one it has not seen settle.
type TrackedPromise = Promise<void> & { status?: string };

class LiveEntry<T> {
  readonly key: string;
  readonly collections: ReadonlySet<string>;
  // Resolves once the first read settles, after which `snapshot` is set.
  readonly loaded: Promise<void>;
  // Set by the first read, before `loaded` resolves.
  snapshot!: LiveSnapshot<T>;
  dropped = false;
  running = false;
  // Changed while a read ran: one more read follows it.
  stale = false;
  private readonly read: () => Promise<T>;
  private readonly cache: LiveCache;
  private readonly listeners = new Set<() => void>();
  private markLoaded!: () => void;
  private everSubscribed = false;
  // Changed while nothing used it: read again when something subscribes.
  private outdated = false;
  private dropTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    cache: LiveCache,
    key: string,
    collections: readonly string[],
    read: () => Promise<T>
  ) {
    this.cache = cache;
    this.key = key;
    this.collections = new Set(collections);
    this.read = read;
    this.loaded = new Promise<void>((resolve) => {
      this.markLoaded = () => {
        (this.loaded as TrackedPromise).status = 'fulfilled';
        resolve();
      };
    });
  }

  get failed(): boolean {
    return this.snapshot?.status === 'error';
  }

  get idle(): boolean {
    return this.listeners.size === 0 && !this.running;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.everSubscribed = true;
    clearTimeout(this.dropTimeout);
    // A render can commit after its entry was dropped, such as when a
    // sibling held the commit back; subscribing brings the entry back.
    if (this.dropped) {
      this.cache.revive(this);
    } else if (this.outdated) {
      this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.failed && this.idle) {
        this.cache.drop(this);
      } else {
        this.dropWhenUnused();
      }
    };
  };

  readonly getSnapshot = (): LiveSnapshot<T> => this.snapshot;

  changed(): void {
    if (this.listeners.size > 0 || this.running) {
      this.refresh();
    } else {
      this.outdated = true;
    }
  }

  // Reads run one at a time, so a slower earlier read never lands after a newer one.
  // A result overtaken by a change is still shown, one step behind, while the
  // next read runs.
  refresh(): void {
    this.outdated = false;
    if (this.running) {
      this.stale = true;
      return;
    }
    this.running = true;
    clearTimeout(this.dropTimeout);
    void this.readUntilFresh();
  }

  drop(): void {
    this.dropped = true;
    clearTimeout(this.dropTimeout);
  }

  private async readUntilFresh(): Promise<void> {
    do {
      this.stale = false;
      const lensVersion = this.cache.lensVersion();
      let next: LiveSnapshot<T>;
      try {
        next = { status: 'ok', value: await this.read() };
      } catch (error) {
        next = { status: 'error', error };
      }
      // Read under another lens: never shown, not even as a first result.
      if (this.cache.lensVersion() !== lensVersion) {
        this.stale = true;
        continue;
      }
      this.snapshot = next;
      this.markLoaded();
      for (const listener of this.listeners) listener();
    } while (this.stale && !this.dropped);
    this.running = false;
    this.dropWhenUnused();
  }

  private dropWhenUnused(): void {
    if (!this.idle || this.dropped) return;
    clearTimeout(this.dropTimeout);
    this.dropTimeout = setTimeout(
      () => this.cache.drop(this),
      this.everSubscribed ? UNSUBSCRIBED_ENTRY_TTL_MS : NEVER_SUBSCRIBED_ENTRY_TTL_MS
    );
  }
}

// One per open store. An entry is created by the first render that asks for
// its key and dropped once nothing has subscribed to it for a while.
export class LiveCache {
  private readonly byKey = new Map<string, LiveEntry<unknown>>();
  // Every entry still followed, including one revived after another took its key.
  private readonly live = new Set<LiveEntry<unknown>>();
  private readonly changes = new Set<string>();
  // Entries a change caught mid-read, which already read again after it.
  private readonly rereading = new Set<LiveEntry<unknown>>();
  private flushTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private disposed = false;
  readonly lensVersion: () => number;

  constructor(store: Store<any>) {
    this.unsubscribe = store.on('change', (collection) => this.notify(collection));
    this.lensVersion = () => store.encryption.lensVersion;
  }

  entry<T>(key: string, collections: readonly string[], read: () => Promise<T>): LiveEntry<T> {
    const existing = this.byKey.get(key);
    if (existing) return existing as LiveEntry<T>;
    const created = new LiveEntry(this, key, collections, read);
    this.add(created as LiveEntry<unknown>);
    created.refresh();
    return created;
  }

  // Called once a render has thrown an entry's error. Dropping it after that
  // render has finished, rather than replacing it when next asked for, spares
  // the render React retries in the same task an extra read; a later render,
  // such as an error boundary's reset, reads again.
  retireAfterThrow(entry: LiveEntry<any>): void {
    setTimeout(() => {
      if (entry.failed && entry.idle) this.drop(entry);
    }, 0);
  }

  drop(entry: LiveEntry<any>): void {
    entry.drop();
    this.live.delete(entry);
    if (this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key);
  }

  revive(entry: LiveEntry<any>): void {
    if (this.disposed) return;
    entry.dropped = false;
    this.add(entry);
    entry.refresh();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.flushTimeout);
    this.unsubscribe();
    for (const entry of this.live) entry.drop();
    this.live.clear();
    this.byKey.clear();
  }

  private add(entry: LiveEntry<unknown>): void {
    this.live.add(entry);
    if (!this.byKey.has(entry.key)) this.byKey.set(entry.key, entry);
  }

  private notify(collection: string): void {
    // A read already running may have read before this change; marking it now,
    // not at the batch, makes it read again as soon as it lands.
    for (const entry of this.live) {
      if (entry.running && entry.collections.has(collection)) {
        entry.stale = true;
        this.rereading.add(entry);
      }
    }
    this.changes.add(collection);
    this.flushTimeout ??= setTimeout(() => this.flush(), CHANGE_BATCH_DELAY_MS);
  }

  private flush(): void {
    this.flushTimeout = undefined;
    const changes = [...this.changes];
    const rereading = [...this.rereading];
    this.changes.clear();
    this.rereading.clear();
    for (const entry of this.live) {
      if (rereading.includes(entry)) continue;
      if (changes.some((collection) => entry.collections.has(collection))) entry.changed();
    }
  }
}
