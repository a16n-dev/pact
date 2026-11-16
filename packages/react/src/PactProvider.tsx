import type { Store } from '@a16n/pact-client';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { PactContext } from './context';
import { LiveCache } from './liveCache';
import { createPactSync } from './syncHooks';

type OpenStore = { store: Store<any>; cache: LiveCache };

export type PactProviderProps = {
  /** Opens the app's store, including any post-open migrations. Called once per mount. */
  open: () => Promise<Store<any>>;
  appId: string;
  /** Shown to the user and the admin on the server. */
  deviceName: string;
  /** Where the server's sign-in page sends the browser back; must be registered for the app. */
  redirectUri: string;
  children: ReactNode;
};

/**
 * Opens the store, renders its children once it is open, syncs once, and
 * disposes the store on unmount. A failure to open is thrown to the nearest
 * error boundary.
 */
export function PactProvider({
  open,
  appId,
  deviceName,
  redirectUri,
  children,
}: PactProviderProps) {
  const [opened, setOpened] = useState<OpenStore | null>(null);
  const [openFailure, setOpenFailure] = useState<{ error: unknown } | null>(null);
  // Within this provider, an open waits for the previous store to be disposed,
  // and one whose effect was already cleaned up (StrictMode's first mount) is skipped.
  const previousClose = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const opening = previousClose.current.then(async (): Promise<OpenStore | null> => {
      if (cancelled) return null;
      const store = await open();
      return { store, cache: new LiveCache(store) };
    });
    opening.then(
      (next) => {
        if (next && !cancelled) setOpened(next);
      },
      (error: unknown) => {
        if (!cancelled) setOpenFailure({ error });
      }
    );
    return () => {
      cancelled = true;
      setOpened(null);
      previousClose.current = opening.then(
        (next) => {
          next?.cache.dispose();
          next?.store.dispose();
        },
        () => {}
      );
    };
  }, []);

  useEffect(() => {
    opened?.store.sync.syncNow().catch(() => {});
  }, [opened]);

  const value = useMemo(
    () =>
      opened
        ? {
            ...opened,
            sync: createPactSync(opened.store, opened.cache, { appId, deviceName, redirectUri }),
          }
        : null,
    [opened, appId, deviceName, redirectUri]
  );

  if (openFailure) throw openFailure.error;
  if (!value) return null;
  return <PactContext value={value}>{children}</PactContext>;
}
