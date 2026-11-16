import { normaliseServerUrl, type SignInResult, type Store } from '@a16n/pact-client';
import { useEffect, useRef } from 'react';
import { type LiveCache, SESSION } from './liveCache';
import { usePactContext } from './context';

export type SignInFailureReason = Extract<SignInResult, { ok: false }>['reason'];

/**
 * The server refused to finish sign-in. `state` and `code` mean the sign-in
 * link was stale or already used, `network` that the server could not be
 * reached, `server` that it failed.
 */
export class SignInError extends Error {
  readonly reason: SignInFailureReason;

  constructor(reason: SignInFailureReason) {
    super(`Sign-in failed: ${reason}`);
    this.name = 'SignInError';
    this.reason = reason;
  }
}

export type PactSync = {
  /**
   * Takes the server URL as the user typed it and resolves with the sign-in
   * page to open. App id, device name and redirect URI come from the provider.
   */
  beginSignIn(url: string): Promise<string>;
  /**
   * Finishes sign-in from the redirect, then pushes everything local and
   * pulls everything remote, blobs included. Rejects with a `SignInError`
   * when the server refuses the code; resolves once signed in, even if that
   * first sync fails.
   */
  completeSignIn(callback: { code: string; state: string }): Promise<void>;
  signOut(): Promise<void>;
  syncNow(): Promise<void>;
};

export function createPactSync(
  store: Store<any>,
  cache: LiveCache,
  signIn: { appId: string; deviceName: string; redirectUri: string }
): PactSync {
  return {
    beginSignIn: async (url) => {
      const { authorizeUrl } = await store.sync.beginSignIn({
        url: normaliseServerUrl(url),
        ...signIn,
      });
      return authorizeUrl;
    },
    completeSignIn: async (callback) => {
      const result = await store.sync.completeSignIn(callback);
      if (!result.ok) throw new SignInError(result.reason);
      cache.notify(SESSION);
      try {
        await store.sync.push();
        await store.sync.pull();
        if (store.blobs.adapter) {
          await store.blobs.push();
          await store.blobs.pullReferenced();
        }
      } catch {
        // The device is signed in by now; writes stay in the outbox for the next sync.
      }
    },
    signOut: async () => {
      await store.sync.signOut();
      cache.notify(SESSION);
    },
    syncNow: () => store.sync.syncNow(),
  };
}

/** Stable functions for sign-in and sync. Wrap calls in a transition for pending state. */
export function usePactSync(): PactSync {
  return usePactContext().sync;
}

/**
 * Syncs each time the app returns to the foreground. `subscribe` reports
 * whether the app is in the foreground whenever that may have changed, and
 * returns an unsubscribe. The first `subscribe` is used for as long as the
 * component stays mounted. The app counts as in the foreground when this mounts.
 */
export function useSyncOnForeground(
  subscribe: (onChange: (foreground: boolean) => void) => () => void
): void {
  const { store } = usePactContext();
  // Only the first is used: resubscribing on re-render would forget a background state.
  const subscribeRef = useRef(subscribe);
  useEffect(() => {
    let wasForeground = true;
    return subscribeRef.current((foreground) => {
      if (foreground && !wasForeground) store.sync.syncNow().catch(() => {});
      wasForeground = foreground;
    });
  }, [store]);
}
