import type { Store } from '@a16n/pact-client';

const CHANGE_BATCH_DELAY_MS = 50;
// Long enough for a component suspended on a first read to commit and
// subscribe after the read settles, including React's fallback throttling.
const UNUSED_ENTRY_TTL_MS = 1_000;

// Not a collection: reported when this device signs in or out.
export const SESSION = '_session';

type LiveSnapshot<T> = { status: 'ok'; value: T } | { status: 'error'; error: unknown };

// React's `use` returns at once for a promise marked fulfilled this way,
// instead of suspending for a tick on one it has not seen settle.
type TrackedPromise = Promise<void> & { status?: string };

class LiveEntry<T> {
  readonly key: string;
  readonly collections: ReadonlySet<string>;
  // Resolves once the first read settles, after which `snapshot` is set.
  readonly loaded: Promise<void>;
  snapshot!: LiveSnapshot<T>;
  dropped = false;
  private readonly read: () => Promise<T>;
  private readonly cache: LiveCache;
  private readonly listeners = new Set<() => void>();
  private markLoaded!: () => void;
  private running = false;
  // Changed while a read ran: read again after it.
  private stale = false;
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

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    clearTimeout(this.dropTimeout);
    // A render can commit after its entry was dropped, such as when a
    // sibling held the commit back; subscribing brings the entry back.
    if (this.dropped) this.cache.revive(this);
    if (this.outdated) this.refresh();
    return () => {
      this.listeners.delete(listener);
      this.dropWhenUnused();
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
      let next: LiveSnapshot<T>;
      try {
        next = { status: 'ok', value: await this.read() };
      } catch (error) {
        next = { status: 'error', error };
      }
      this.snapshot = next;
      this.markLoaded();
      for (const listener of this.listeners) listener();
    } while (this.stale && !this.dropped);
    this.running = false;
    this.dropWhenUnused();
  }

  private dropWhenUnused(): void {
    if (this.listeners.size > 0 || this.running || this.dropped) return;
    clearTimeout(this.dropTimeout);
    this.dropTimeout = setTimeout(() => this.cache.drop(this), UNUSED_ENTRY_TTL_MS);
  }
}

// One per open store. An entry is created by the first render that asks for
// its key and dropped once nothing has subscribed to it for a while.
export class LiveCache {
  private readonly byKey = new Map<string, LiveEntry<unknown>>();
  // Every entry still followed, including one revived after another took its key.
  private readonly live = new Set<LiveEntry<unknown>>();
  private readonly changes = new Set<string>();
  private flushTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribes: Array<() => void>;
  private disposed = false;

  constructor(store: Store<any>) {
    this.unsubscribes = [
      store.on('change', (collection) => this.notify(collection)),
      store.on('signedOut', () => this.notify(SESSION)),
    ];
  }

  entry<T>(key: string, collections: readonly string[], read: () => Promise<T>): LiveEntry<T> {
    const existing = this.byKey.get(key);
    if (existing) return existing as LiveEntry<T>;
    const created = new LiveEntry(this, key, collections, read);
    this.add(created as LiveEntry<unknown>);
    created.refresh();
    return created;
  }

  notify(collection: string): void {
    this.changes.add(collection);
    this.flushTimeout ??= setTimeout(() => this.flush(), CHANGE_BATCH_DELAY_MS);
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
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    for (const entry of this.live) entry.drop();
    this.live.clear();
    this.byKey.clear();
  }

  private add(entry: LiveEntry<unknown>): void {
    this.live.add(entry);
    if (!this.byKey.has(entry.key)) this.byKey.set(entry.key, entry);
  }

  private flush(): void {
    this.flushTimeout = undefined;
    const changes = [...this.changes];
    this.changes.clear();
    for (const entry of this.live) {
      if (changes.some((collection) => entry.collections.has(collection))) entry.changed();
    }
  }
}
