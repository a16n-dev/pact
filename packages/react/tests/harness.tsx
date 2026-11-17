import { blobFields, defineCollection, InMemoryAdapter, Store } from '@a16n/pact-client';
import { cleanup, render } from '@testing-library/react';
import { Component, type ReactNode, StrictMode, Suspense } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { FakeServer } from '../../client/tests/fakeServer';
import { createPactHooks, PactProvider } from '../src';

export const APP_ID = 'app';
export const REDIRECT_URI = 'https://app.test/callback';

export const notes = defineCollection({
  name: 'notes',
  idPrefix: 'nt',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), imageHash: z.string().default('') }),
});

export const tags = defineCollection({
  name: 'tags',
  idPrefix: 'tg',
  merge: 'field',
  schema: (base) => base.extend({ label: z.string() }),
});

const collections = [notes, tags] as const;

export type TestStore = Store<typeof collections>;

export let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  server.createApp(APP_ID, [REDIRECT_URI]);
  server.createUser('alice', 'pw');
  vi.stubGlobal('fetch', server.fetch);
  vi.stubGlobal('WebSocket', server.WebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

export function memoryBlobs() {
  const data = new Map<string, { bytes: Uint8Array; mime: string }>();
  return {
    has: async (h: string) => data.has(h),
    read: async (h: string) => data.get(h)?.bytes ?? null,
    mimeType: async (h: string) => data.get(h)?.mime ?? null,
    write: async (h: string, bytes: Uint8Array, mime: string) => void data.set(h, { bytes, mime }),
    delete: async (h: string) => void data.delete(h),
    list: async () => Array.from(data.keys()),
    uriFor: (h: string) => (data.has(h) ? `mem://${h}` : null),
  };
}

type StoreOptions = { blobs?: boolean; adapter?: InMemoryAdapter };

export function createStore(opts: StoreOptions = {}): Promise<TestStore> {
  return Store.create({
    adapter: opts.adapter ?? new InMemoryAdapter(),
    collections,
    blobs: opts.blobs ? memoryBlobs() : undefined,
    blobHashes: opts.blobs ? blobFields({ notes: ['imageHash'] }) : undefined,
  });
}

export async function authorize(
  store: TestStore,
  deviceName: string
): Promise<{ code: string; state: string }> {
  const { authorizeUrl } = await store.sync.beginSignIn({
    url: server.origin,
    appId: APP_ID,
    deviceName,
    redirectUri: REDIRECT_URI,
  });
  const redirect = server.authorize(authorizeUrl, { username: 'alice', password: 'pw' });
  if ('error' in redirect) throw new Error(redirect.error);
  return redirect;
}

export async function signedInStore(
  deviceName: string,
  opts: StoreOptions = {}
): Promise<TestStore> {
  const store = await createStore(opts);
  const result = await store.sync.completeSignIn(await authorize(store, deviceName));
  if (!result.ok) throw new Error(result.reason);
  return store;
}

export const { usePactStore, useLiveQuery, useDocument, useCollection } =
  createPactHooks<TestStore>();

export function renderWithPact(
  ui: ReactNode,
  opts: { open: () => Promise<TestStore>; strict?: boolean; boundary?: boolean }
) {
  const provider = (
    <PactProvider
      open={opts.open}
      appId={APP_ID}
      deviceName='Test device'
      redirectUri={REDIRECT_URI}
    >
      <ErrorBoundary>
        <Suspense fallback={<p>loading</p>}>{ui}</Suspense>
      </ErrorBoundary>
    </PactProvider>
  );
  const tree = opts.boundary ? <ErrorBoundary>{provider}</ErrorBoundary> : provider;
  return render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? <p>caught: {this.state.error.message}</p> : this.props.children;
  }
}
