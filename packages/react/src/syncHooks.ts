import { normaliseServerUrl, type SignInResult, type SyncConnection } from '@a16n/pact-client';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { usePact } from './PactProvider';

const CONNECTION_KEY = ['pact', 'connection'] as const;

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

/** Suspends until read. Null when signed out. */
export function useSyncConnection(): SyncConnection | null {
  const { store } = usePact();
  return useSuspenseQuery({
    queryKey: CONNECTION_KEY,
    queryFn: () => store.sync.connection(),
  }).data;
}

/**
 * Takes the server URL as the user typed it and resolves with the sign-in
 * page to open. Finish with `useCompleteSignIn` or `useSignInCallback`.
 */
export function useBeginSignIn() {
  const { store, signIn } = usePact();
  return useMutation({
    mutationFn: async (url: string) => {
      const { authorizeUrl } = await store.sync.beginSignIn({
        url: normaliseServerUrl(url),
        ...signIn,
      });
      return authorizeUrl;
    },
  });
}

/**
 * Finishes sign-in from the redirect's `code` and `state`, then pushes
 * everything local and pulls everything remote, blobs included. Rejects with
 * a `SignInError` when the server refuses the code.
 */
export function useCompleteSignIn() {
  const { store } = usePact();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (callback: { code: string; state: string }) => {
      const result = await store.sync.completeSignIn(callback);
      if (!result.ok) throw new SignInError(result.reason);
      await store.sync.push();
      await store.sync.pull();
      if (store.blobs.adapter) {
        await store.blobs.push();
        await store.blobs.pullReferenced();
      }
    },
    // The first sync can fail after the device has signed in.
    onSettled: () => queryClient.invalidateQueries(),
  });
}

export function useSignOut() {
  const { store } = usePact();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => store.sync.signOut(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONNECTION_KEY }),
  });
}

export function useSyncNow() {
  const { store } = usePact();
  return useMutation({ mutationFn: () => store.sync.syncNow() });
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
  const { store } = usePact();
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
