import type { Store } from '@a16n/pact-client';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const CHANGE_BATCH_DELAY_MS = 50;

type AnyStore = Store<any>;

type SignInConfig = { appId: string; deviceName: string; redirectUri: string };

type PactContextValue = { store: AnyStore; signIn: SignInConfig };

const PactContext = createContext<PactContextValue | null>(null);

export type PactProviderProps<S extends AnyStore> = {
  /** Opens the app's store, including any post-open migrations. Called once per mount. */
  open: () => Promise<S>;
  appId: string;
  /** Shown to the user and the admin on the server. */
  deviceName: string;
  /** Where the server's sign-in page sends the browser back; must be registered for the app. */
  redirectUri: string;
  /**
   * The queries that read each collection, refreshed when it changes.
   * Besides collection names, the store reports `_outbox` when the outbox
   * changes and `_blobs` when local blobs change; map `_blobs` to the queries
   * that render blob URIs. Names left out refresh nothing. Without a map
   * every change refreshes every query.
   */
  queryKeys?: Record<string, readonly QueryKey[]>;
  children: ReactNode;
};

/**
 * Opens the store and renders its children once it is open, then keeps the
 * query cache in step with it and syncs once. Must be inside a
 * `QueryClientProvider`. A failure to open is thrown to the nearest error
 * boundary.
 */
export function PactProvider<S extends AnyStore>({
  open,
  appId,
  deviceName,
  redirectUri,
  queryKeys,
  children,
}: PactProviderProps<S>) {
  const queryClient = useQueryClient();
  const [store, setStore] = useState<S | null>(null);
  const [openFailure, setOpenFailure] = useState<{ error: unknown } | null>(null);
  // Within this provider, an open waits for the previous store to be disposed,
  // and one whose effect was already cleaned up (StrictMode's first mount) is skipped.
  const previousClose = useRef<Promise<void>>(Promise.resolve());
  // Read when a batch flushes, so an inline map does not resubscribe each render.
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;

  useEffect(() => {
    let cancelled = false;
    const opening = previousClose.current.then(() => (cancelled ? null : open()));
    opening.then(
      (opened) => {
        if (opened && !cancelled) setStore(opened);
      },
      (error: unknown) => {
        if (!cancelled) setOpenFailure({ error });
      }
    );
    return () => {
      cancelled = true;
      setStore(null);
      previousClose.current = opening.then(
        (opened) => opened?.dispose(),
        () => {}
      );
    };
  }, []);

  useEffect(() => {
    if (!store) return;
    const changed = new Set<string>();
    let flushTimeout: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimeout = undefined;
      const keys = queryKeysRef.current;
      if (!keys) {
        void queryClient.invalidateQueries();
      } else {
        for (const collection of changed) {
          for (const queryKey of keys[collection] ?? []) {
            void queryClient.invalidateQueries({ queryKey });
          }
        }
      }
      changed.clear();
    };
    const unsubscribeChange = store.on('change', (collection) => {
      changed.add(collection);
      flushTimeout ??= setTimeout(flush, CHANGE_BATCH_DELAY_MS);
    });
    const unsubscribeSignedOut = store.on('signedOut', () => {
      void queryClient.invalidateQueries();
    });
    store.sync.syncNow().catch(() => {});
    return () => {
      clearTimeout(flushTimeout);
      unsubscribeChange();
      unsubscribeSignedOut();
    };
  }, [store, queryClient]);

  const value = useMemo(
    () => (store ? { store, signIn: { appId, deviceName, redirectUri } } : null),
    [store, appId, deviceName, redirectUri]
  );

  if (openFailure) throw openFailure.error;
  if (!value) return null;
  return <PactContext value={value}>{children}</PactContext>;
}

export function usePact(): PactContextValue {
  const value = useContext(PactContext);
  if (!value) throw new Error('Pact hooks must be used inside <PactProvider>');
  return value;
}

/**
 * The open store. Pass the app's store type, e.g. `usePactStore<AppStore>()`,
 * for typed collections; wrapping that in an app hook keeps it in one place.
 */
export function usePactStore<S extends AnyStore = Store>(): S {
  return usePact().store as S;
}
