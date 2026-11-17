import { InMemoryAdapter } from '@a16n/pact-client';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_ID,
  createStore,
  renderWithPact,
  server,
  signedInStore,
  sleep,
  usePactStore,
  type TestStore,
} from './harness';

let probed: TestStore | null = null;

function StoreProbe() {
  probed = usePactStore();
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

  it('opens the store once under StrictMode', async () => {
    const open = vi.fn(() => createStore());
    renderWithPact(<StoreProbe />, { open, strict: true });
    await screen.findByText('open');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps one realtime connection for a signed-in store under StrictMode', async () => {
    const adapter = new InMemoryAdapter();
    (await signedInStore('Laptop', { adapter })).dispose();
    await waitFor(() => expect(server.openSockets(APP_ID)).toBe(0));
    renderWithPact(<StoreProbe />, { open: () => createStore({ adapter }), strict: true });
    await screen.findByText('open');
    await waitFor(() => expect(server.openSockets(APP_ID)).toBe(1));
    await sleep(100);
    expect(server.openSockets(APP_ID)).toBe(1);
  });

  it('throws an open failure to the error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('no storage');
    renderWithPact(<StoreProbe />, { open: async () => Promise.reject(failure), boundary: true });
    expect(await screen.findByText('caught: no storage')).toBeTruthy();
  });

  it('syncs once after opening and ignores a failure', async () => {
    const store = await signedInStore('Laptop');
    server.offline = true;
    const syncNow = vi.spyOn(store.sync, 'syncNow');
    renderWithPact(<StoreProbe />, { open: async () => store });
    await screen.findByText('open');
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
  });
});
