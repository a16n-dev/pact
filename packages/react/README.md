# Pact React

React bindings for [`@a16n/pact-client`](../client) with [TanStack Query](https://tanstack.com/query): a provider that opens the store and keeps the query cache in step with it, and hooks for sign-in and sync. It renders no UI and works on web and React Native alike; anything platform-specific is passed in.

```
pnpm add @a16n/pact-react @a16n/pact-client @tanstack/react-query
```

The package is not published to npm yet.

Reading and writing documents stays in your own queries and mutations.

## Setup

Wrap the app in `PactProvider`, inside a `QueryClientProvider`. It calls `open` once, renders its children when the store is open, syncs once, and disposes the store on unmount.

```tsx
import { Store } from '@a16n/pact-client';
import { PactProvider, usePactStore } from '@a16n/pact-react';

const collections = [todos, lists] as const;
export type AppStore = Store<typeof collections>;

async function openStore(): Promise<AppStore> {
  const store = await Store.create({ adapter: createAdapter(), collections });
  // post-open migrations go here
  return store;
}

export const useAppStore = () => usePactStore<AppStore>();

<QueryClientProvider client={queryClient}>
  <PactProvider
    open={openStore}
    appId='myapp'
    deviceName={deviceName}
    redirectUri='https://myapp.example.com/auth/callback'
    queryKeys={{ todos: [['todos'], ['todo']], lists: [['lists']] }}
  >
    <App />
  </PactProvider>
</QueryClientProvider>;
```

When the store reports a change, the provider invalidates the query keys mapped to that collection, batching changes that arrive together. Besides your collections, the store reports `_outbox` when the outbox changes and `_blobs` when local blobs change: an app that renders blob URIs should map `_blobs` to those queries. Without `queryKeys`, every change invalidates every query, so each local write invalidates everything twice, once for the write and once when the outbox clears. A sign-out from anywhere, such as a revoked token, invalidates every query.

## Signing in

```tsx
const connection = useSyncConnection(); // suspends; { url, deviceName } or null
const beginSignIn = useBeginSignIn();
const signOut = useSignOut();

const authorizeUrl = await beginSignIn.mutateAsync('sync.example.com');
// open authorizeUrl; the server sends the browser back to redirectUri
```

On the page or screen at `redirectUri`, `useSignInCallback` finishes sign-in once per code, even under StrictMode, then pushes everything local and pulls everything remote, blobs included. It reports success once the device is signed in, even if that first sync fails; later syncs catch up:

```tsx
const result = useSignInCallback({ code, state }); // idle | pending | success | error
if (result.status === 'error') {
  const message = result.error instanceof SignInError ? copy[result.error.reason] : copy.unknown;
}
```

On the web, once it succeeds, remove `code` and `state` from the URL or navigate away: a reload would send the used code again and report an error although the device is signed in.

`SignInError.reason` is `state` or `code` for a stale or reused link, `network` when the server could not be reached, and `server` when it failed. `useCompleteSignIn` is the same as a mutation, for apps that receive the redirect elsewhere.

## Syncing

`useSyncNow()` is a mutation for pull-to-refresh and the like. `useSyncOnForeground(subscribe)` syncs whenever the app returns to the foreground. `subscribe` reports whether the app is in the foreground and returns an unsubscribe. Only the first `subscribe` is used while the component is mounted.

On the web:

```ts
function subscribeToVisibility(onChange: (foreground: boolean) => void) {
  const listener = () => onChange(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

useSyncOnForeground(subscribeToVisibility);
```

On React Native:

```ts
import { AppState } from 'react-native';

function subscribeToAppState(onChange: (foreground: boolean) => void) {
  const subscription = AppState.addEventListener('change', (state) => onChange(state === 'active'));
  return () => subscription.remove();
}

useSyncOnForeground(subscribeToAppState);
```

## License

MIT
