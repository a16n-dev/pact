import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePactStore } from '../src';
import { createStore, renderWithPact, server, signedInStore, type TestStore } from './harness';

let probed: TestStore | null = null;

function StoreProbe() {
  probed = usePactStore<TestStore>();
  return <p>open</p>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('PactProvider', () => {
  it('renders its children only once the store is open', async () => {
    const opening = deferred<TestStore>();
    renderWithPact(<StoreProbe />, { open: () => opening.promise });
    expect(screen.queryByText('open')).toBeNull();
    const store = await createStore();
    opening.resolve(store);
    expect(await screen.findByText('open')).toBeTruthy();
    expect(probed).toBe(store);
  });

  it('disposes the store on unmount', async () => {
    const store = await createStore();
    const dispose = vi.spyOn(store, 'dispose');
    const { unmount } = renderWithPact(<StoreProbe />, { open: async () => store });
    await screen.findByText('open');
    unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('opens one store at a time under StrictMode', async () => {
    const stores: TestStore[] = [];
    let openCount = 0;
    const open = async () => {
      openCount += 1;
      expect(stores.every((s) => vi.mocked(s.dispose).mock.calls.length > 0)).toBe(true);
      const store = await createStore();
      vi.spyOn(store, 'dispose');
      stores.push(store);
      return store;
    };
    renderWithPact(<StoreProbe />, { open, strict: true });
    await screen.findByText('open');
    expect(openCount).toBe(2);
  });

  it('throws an open failure to the error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('no storage');
    renderWithPact(<StoreProbe />, { open: async () => Promise.reject(failure), boundary: true });
    expect(await screen.findByText('caught: no storage')).toBeTruthy();
  });

  it('syncs once after opening and ignores a failure', async () => {
    const store = await createStore();
    const syncNow = vi.spyOn(store.sync, 'syncNow').mockRejectedValue(new Error('offline'));
    renderWithPact(<StoreProbe />, { open: async () => store });
    await screen.findByText('open');
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
  });

  it('invalidates the mapped queries once per batch of changes', async () => {
    const store = await createStore();
    const { queryClient } = renderWithPact(<StoreProbe />, {
      open: async () => store,
      queryKeys: { notes: [['notes'], ['note']], tags: [['tags']] },
    });
    await screen.findByText('open');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await store.collection('notes').create({ title: 'a' });
    await store.collection('notes').create({ title: 'b' });
    await store.collection('notes').create({ title: 'c' });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ['notes'] }], [{ queryKey: ['note'] }]]);
  });

  it('invalidates every query on a change when there is no map', async () => {
    const store = await createStore();
    const { queryClient } = renderWithPact(<StoreProbe />, { open: async () => store });
    await screen.findByText('open');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await store.collection('tags').create({ label: 'x' });
    await store.collection('notes').create({ title: 'a' });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(invalidate.mock.calls).toEqual([[]]);
  });

  it('invalidates every query when the store is signed out', async () => {
    const store = await signedInStore('Laptop');
    const { queryClient } = renderWithPact(<StoreProbe />, {
      open: async () => store,
      queryKeys: {},
    });
    await screen.findByText('open');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    server.revoke((await store.sync.credentials())!.token);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith());
  });
});
