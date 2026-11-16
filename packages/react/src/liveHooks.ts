import type { CollectionName, DocumentOf, Store, SyncConnection } from '@a16n/pact-client';
import { use, useSyncExternalStore } from 'react';
import { usePactContext } from './context';

type DefsOf<S> = S extends Store<infer Defs> ? Defs : never;

export type LiveQuery<S, T> = {
  /**
   * Identifies the read: components using the same key share one read and
   * its result. Every input `read` uses, such as an id or a filter, must be
   * in the key. `NaN` and `Infinity` count as `null`.
   */
  key: LiveKey;
  /**
   * The collections the read depends on; a change to any of them re-runs it.
   * Besides collection names, the store reports `_blobs` when local blobs
   * change, `_outbox` when the outbox does, and `_session` when the device
   * signs in or out.
   */
  collections: readonly (CollectionName<DefsOf<S>> | `_${string}`)[];
  read: (store: S) => Promise<T>;
};

type LiveKey = readonly (string | number | boolean | null)[];

// App keys and this package's own are kept apart so they cannot share an entry.
function useLive<T>(
  key: readonly ['app' | 'pact', ...LiveKey],
  collections: readonly string[],
  read: (store: Store<any>) => Promise<T>
): T {
  const { store, cache } = usePactContext();
  const entry = cache.entry(JSON.stringify(key), collections, () => read(store));
  use(entry.loaded);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  if (snapshot.status === 'error') {
    cache.retireAfterThrow(entry);
    throw snapshot.error;
  }
  return snapshot.value;
}

/**
 * Hooks typed to the app's store, e.g.
 * `export const { usePactStore, useLiveQuery, useDocument, useCollection } = createPactHooks<AppStore>()`.
 * Live reads suspend until their first result and re-render when it changes;
 * a failed read throws to the nearest error boundary.
 */
export function createPactHooks<S extends Store<any>>() {
  type Defs = DefsOf<S>;
  return {
    usePactStore: (): S => usePactContext().store as S,

    useLiveQuery: <T>({ key, collections, read }: LiveQuery<S, T>): T =>
      useLive(['app', ...key], collections, read as (store: Store<any>) => Promise<T>),

    /** Null when the document does not exist or is deleted. */
    useDocument: <Name extends CollectionName<Defs>>(
      collection: Name,
      id: string
    ): DocumentOf<Defs, Name> | null =>
      useLive(['pact', 'document', collection, id], [collection], (store) =>
        store.collection(collection).get(id)
      ) as DocumentOf<Defs, Name> | null,

    /** Every live document in the collection. */
    useCollection: <Name extends CollectionName<Defs>>(
      collection: Name
    ): DocumentOf<Defs, Name>[] =>
      useLive(['pact', 'collection', collection], [collection], (store) =>
        store.collection(collection).list()
      ) as DocumentOf<Defs, Name>[],
  };
}

/** Suspends until read, then follows sign-in and sign-out. Null when signed out. */
export function useSyncConnection(): SyncConnection | null {
  return useLive(['pact', 'connection'], ['_session'], (store) => store.sync.connection());
}
