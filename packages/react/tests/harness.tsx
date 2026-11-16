import { blobFields, defineCollection, InMemoryAdapter, Store } from '@a16n/pact-client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { Component, type ReactNode, StrictMode, Suspense } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { FakeServer } from '../../client/tests/fakeServer';
import { PactProvider } from '../src';

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

export function createStore(opts: { blobs?: boolean } = {}): Promise<TestStore> {
  return Store.create({
    adapter: new InMemoryAdapter(),
    collections,
    blobs: opts.blobs ? memoryBlobs() : undefined,
    blobHashes: opts.blobs ? blobFields({ notes: ['imageHash'] }) : undefined,
  });
}

/** Signs in as the user on the server's page, returning the redirect's query. */
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
  opts: { blobs?: boolean } = {}
): Promise<TestStore> {
  const store = await createStore(opts);
  const result = await store.sync.completeSignIn(await authorize(store, deviceName));
  if (!result.ok) throw new Error(result.reason);
  return store;
}

export function renderWithPact(
  ui: ReactNode,
  opts: {
    open: () => Promise<TestStore>;
    queryKeys?: Record<string, readonly QueryKey[]>;
    strict?: boolean;
    boundary?: boolean;
  }
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const provider = (
    <PactProvider
      open={opts.open}
      appId={APP_ID}
      deviceName='Test device'
      redirectUri={REDIRECT_URI}
      queryKeys={opts.queryKeys}
    >
      <Suspense fallback={null}>{ui}</Suspense>
    </PactProvider>
  );
  const tree = (
    <QueryClientProvider client={queryClient}>
      {opts.boundary ? <ErrorBoundary>{provider}</ErrorBoundary> : provider}
    </QueryClientProvider>
  );
  const result = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...result, queryClient };
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
