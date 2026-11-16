import { act, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  SignInError,
  useBeginSignIn,
  useCompleteSignIn,
  useSignInCallback,
  useSignOut,
  useSyncConnection,
  useSyncNow,
  useSyncOnForeground,
} from '../src';
import {
  APP_ID,
  authorize,
  createStore,
  REDIRECT_URI,
  renderWithPact,
  server,
  signedInStore,
  type TestStore,
} from './harness';

function Connection() {
  const connection = useSyncConnection();
  return <p>{connection ? `connected: ${connection.deviceName}` : 'signed out'}</p>;
}

async function withHook<T>(store: TestStore, hook: () => T) {
  const result: { current: T | null } = { current: null };
  function Probe() {
    result.current = hook();
    return null;
  }
  const rendered = renderWithPact(
    <>
      <Probe />
      <Connection />
    </>,
    { open: async () => store, queryKeys: {} }
  );
  await screen.findByText(/connected|signed out/);
  return { ...rendered, result: result as { current: T } };
}

describe('sync hooks', () => {
  it('useSyncConnection reads the connection from the store', async () => {
    await withHook(await signedInStore('Laptop'), () => null);
    expect(screen.getByText('connected: Laptop')).toBeTruthy();
  });

  it('useBeginSignIn normalises the URL and signs in with the provider config', async () => {
    const store = await createStore();
    const { result } = await withHook(store, useBeginSignIn);
    let authorizeUrl = '';
    await act(async () => {
      authorizeUrl = await result.current.mutateAsync('sync.test');
    });
    const params = new URL(authorizeUrl).searchParams;
    expect(authorizeUrl.startsWith(`${server.origin}/oauth/authorize`)).toBe(true);
    expect(params.get('app_id')).toBe(APP_ID);
    expect(params.get('device_name')).toBe('Test device');
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('useCompleteSignIn pushes, then pulls, then syncs blobs and refreshes every query', async () => {
    const other = await signedInStore('Phone', { blobs: true });
    const remoteHash = await other.blobs.write(new TextEncoder().encode('remote'), 'image/png');
    await other.collection('notes').create({ id: 'nt-remote', title: 'r', imageHash: remoteHash });
    await other.sync.syncNow();

    const store = await createStore({ blobs: true });
    const localHash = await store.blobs.write(new TextEncoder().encode('local'), 'image/png');
    await store.collection('notes').create({ id: 'nt-local', title: 'l', imageHash: localHash });
    const { result, queryClient } = await withHook(store, useCompleteSignIn);
    expect(screen.getByText('signed out')).toBeTruthy();
    const redirect = await authorize(store, 'Laptop');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const calls: string[] = [];
    const track = <T extends object>(name: string, target: T, method: keyof T & string) => {
      const original = target[method] as () => Promise<unknown>;
      vi.spyOn(target, method as never).mockImplementation((() => {
        calls.push(name);
        return original();
      }) as never);
    };
    track('sync.push', store.sync, 'push');
    track('sync.pull', store.sync, 'pull');
    track('blobs.push', store.blobs, 'push');
    track('blobs.pullReferenced', store.blobs, 'pullReferenced');

    await act(() => result.current.mutateAsync(redirect));

    expect(server.versionsOf(APP_ID, 'notes', 'nt-local')).toHaveLength(1);
    expect((await store.collection('notes').get('nt-remote'))?.title).toBe('r');
    expect(server.requests).toContainEqual({ method: 'PUT', path: `/sync/blobs/${localHash}` });
    expect(await store.blobs.has(remoteHash)).toBe(true);
    expect(calls).toEqual(['sync.push', 'sync.pull', 'blobs.push', 'blobs.pullReferenced']);
    expect(invalidate).toHaveBeenCalledWith();
    expect(await screen.findByText('connected: Laptop')).toBeTruthy();
    other.dispose();
  });

  it('useCompleteSignIn rejects with the reason the server gave', async () => {
    const store = await createStore();
    const { result } = await withHook(store, useCompleteSignIn);
    const { code } = await authorize(store, 'Laptop');
    let error: unknown;
    await act(async () => {
      error = await result.current.mutateAsync({ code, state: 'stale' }).catch((e) => e);
    });
    expect(error).toBeInstanceOf(SignInError);
    expect((error as SignInError).reason).toBe('state');
    expect(await store.sync.connection()).toBeNull();
  });

  it('useSignOut signs the store out and refreshes the connection', async () => {
    const store = await signedInStore('Laptop');
    const { result } = await withHook(store, useSignOut);
    await act(() => result.current.mutateAsync());
    expect(await store.sync.credentials()).toBeNull();
    expect(await screen.findByText('signed out')).toBeTruthy();
  });

  it('useSyncNow drains the outbox and pulls', async () => {
    const store = await signedInStore('Laptop');
    const other = await signedInStore('Phone');
    const { result } = await withHook(store, useSyncNow);
    server.offline = true;
    await store.collection('notes').create({ id: 'nt-1', title: 'mine' });
    server.offline = false;
    await other.collection('notes').create({ id: 'nt-2', title: 'theirs' });
    await other.sync.drain();
    await act(() => result.current.mutateAsync());
    expect(await store.sync.pending()).toBe(0);
    expect((await store.collection('notes').get('nt-2'))?.title).toBe('theirs');
    other.dispose();
  });
});

describe('useSyncOnForeground', () => {
  it('syncs only when the app returns to the foreground', async () => {
    const store = await createStore();
    const syncNow = vi.spyOn(store.sync, 'syncNow').mockResolvedValue();
    let report: (foreground: boolean) => void = () => {};
    const unsubscribe = vi.fn();
    const subscribe = (onChange: (foreground: boolean) => void) => {
      report = onChange;
      return unsubscribe;
    };
    const { unmount } = await withHook(store, () => useSyncOnForeground(subscribe));
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
    syncNow.mockClear();

    report(true);
    expect(syncNow).not.toHaveBeenCalled();
    report(false);
    report(false);
    expect(syncNow).not.toHaveBeenCalled();
    report(true);
    report(true);
    expect(syncNow).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('remembers the background across re-renders with an inline subscribe', async () => {
    const store = await createStore();
    const syncNow = vi.spyOn(store.sync, 'syncNow').mockResolvedValue();
    let report: (foreground: boolean) => void = () => {};
    let subscriptions = 0;
    let rerender: (n: number) => void = () => {};
    await withHook(store, () => {
      const [, setCount] = useState(0);
      rerender = setCount;
      useSyncOnForeground((onChange) => {
        subscriptions += 1;
        report = onChange;
        return () => {};
      });
    });
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
    syncNow.mockClear();

    report(false);
    act(() => rerender(1));
    report(true);
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(subscriptions).toBe(1);
  });

  it('ignores a failed sync', async () => {
    const store = await createStore();
    const syncNow = vi.spyOn(store.sync, 'syncNow').mockRejectedValue(new Error('offline'));
    let report: (foreground: boolean) => void = () => {};
    await withHook(store, () =>
      useSyncOnForeground((onChange) => {
        report = onChange;
        return () => {};
      })
    );
    report(false);
    report(true);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(2));
  });
});

describe('useSignInCallback', () => {
  function renderCallback(store: TestStore, params: { code: string | null; state: string | null }) {
    let latest: ReturnType<typeof useSignInCallback> | null = null;
    function Probe() {
      latest = useSignInCallback(params);
      return <p>status: {latest.status}</p>;
    }
    renderWithPact(<Probe />, { open: async () => store, strict: true });
    return () => latest!;
  }

  it('sends the code once under StrictMode and reports success', async () => {
    const store = await createStore();
    const completeSignIn = vi.spyOn(store.sync, 'completeSignIn');
    renderCallback(store, await authorize(store, 'Laptop'));
    expect(await screen.findByText('status: pending')).toBeTruthy();
    expect(await screen.findByText('status: success')).toBeTruthy();
    expect(completeSignIn).toHaveBeenCalledTimes(1);
    expect(await store.sync.connection()).toEqual({ url: server.origin, deviceName: 'Laptop' });
  });

  it('reports the failure reason', async () => {
    const store = await createStore();
    const { code } = await authorize(store, 'Laptop');
    const status = renderCallback(store, { code, state: 'stale' });
    expect(await screen.findByText('status: error')).toBeTruthy();
    const latest = status();
    expect(latest.status === 'error' && latest.error).toBeInstanceOf(SignInError);
  });

  it('sends nothing while a parameter is missing', async () => {
    const store = await createStore();
    const completeSignIn = vi.spyOn(store.sync, 'completeSignIn');
    renderCallback(store, { code: 'abc', state: null });
    expect(await screen.findByText('status: idle')).toBeTruthy();
    expect(completeSignIn).not.toHaveBeenCalled();
  });
});
