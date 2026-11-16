# Pact React

React bindings for [`@a16n/pact-client`](../client): a provider that opens the store, live reads that update whenever the store changes, and hooks for sign-in and sync. It renders no UI and works on web and React Native alike; anything platform-specific is passed in.

```
pnpm add @a16n/pact-react @a16n/pact-client
```

The package is not published to npm yet.

## Setup

Wrap the app in `PactProvider`. It calls `open` once, renders its children when the store is open, syncs once, and disposes the store on unmount. Create the hooks typed to your store once, with `createPactHooks`.

```tsx
import { Store } from '@a16n/pact-client';
import { createPactHooks, PactProvider } from '@a16n/pact-react';

const collections = [todos, lists] as const;
type AppStore = Store<typeof collections>;

async function openStore(): Promise<AppStore> {
  const store = await Store.create({ adapter: createAdapter(), collections });
  // post-open migrations go here
  return store;
}

export const { usePactStore, useLiveQuery, useDocument, useCollection } =
  createPactHooks<AppStore>();

<PactProvider
  open={openStore}
  appId='myapp'
  deviceName={deviceName}
  redirectUri='https://myapp.example.com/auth/callback'
>
  <App />
</PactProvider>;
```

On React Native, `redirectUri` is your app's deep link, such as `myapp://auth/callback`.

## Live reads

Live reads suspend until their first result, so render them inside a `Suspense` boundary. They re-render when a collection they read changes, whether from a local write, a pull or realtime. A failed read throws to the nearest error boundary.

```tsx
function TodoList({ listId }: { listId: string }) {
  const { list, todos } = useLiveQuery({
    key: ['todo-list', listId],
    collections: ['lists', 'todos'],
    read: async (store) => {
      const [list, todos] = await Promise.all([
        store.collection('lists').get(listId),
        store.collection('todos').listByIndex('byList', listId),
      ]);
      return { list, todos };
    },
  });
  return (
    <section>
      <h2>{list?.name}</h2>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </section>
  );
}
```

- `key` identifies the read: components using the same key share one read and one result. It is a list of strings, numbers, booleans and nulls, and every input `read` uses, such as `listId` here, must be in it.
- `collections` lists what the read depends on. Besides your collections, the store reports `_blobs` when local blobs change, so a read that renders blob URIs should name it.
- `useDocument(name, id)` is one document, or `null` when it is missing or deleted, and `useCollection(name)` is every live document in a collection.
- Each live read in a component suspends in turn, so a second one only starts once the first has loaded. Read what a component needs in one `useLiveQuery`, as above, or split the reads across sibling components.
- A new key, such as a different `listId`, suspends while it loads and shows the nearest `Suspense` fallback. To keep showing the previous result meanwhile, change it inside a transition or pass it through `useDeferredValue`.

Writes go straight to the store, e.g. `usePactStore().collection('todos').create(...)`; the reads that depend on them update on their own.

## Signing in

`usePactSync()` returns stable async functions: `beginSignIn(url)`, `completeSignIn({ code, state })`, `signOut()` and `syncNow()`. They hold no pending or error state; use a transition for that.

```tsx
const connection = useSyncConnection(); // suspends; { url, deviceName } or null
const { beginSignIn, signOut } = usePactSync();
const [isPending, startTransition] = useTransition();

const connect = (url: string) =>
  startTransition(async () => {
    const authorizeUrl = await beginSignIn(url); // a bare host means https://
    openBrowser(authorizeUrl);
  });
```

`useSyncConnection` follows sign-in and sign-out, whether through these functions or on the store directly (such as a deep-link handler outside React), including a sign-out the server forces by revoking the token.

On the page or screen at `redirectUri`, `useSignInCallback` finishes sign-in once per code, even under StrictMode, then pushes everything local and pulls everything remote, blobs included. It reports success once the device is signed in, even if that first sync fails; later syncs catch up.

```tsx
const result = useSignInCallback({ code, state }); // idle | pending | success | error
if (result.status === 'error') {
  const message = result.error instanceof SignInError ? copy[result.error.reason] : copy.unknown;
}
```

On the web, once it succeeds, remove `code` and `state` from the URL or navigate away: a reload would send the used code again and report an error although the device is signed in.

`SignInError.reason` is `state` or `code` for a stale or reused link, `network` when the server could not be reached, and `server` when it failed.

## Syncing

Call `syncNow()` from `usePactSync` for pull-to-refresh, inside a transition for a pending state. `useSyncOnForeground(subscribe)` syncs whenever the app returns to the foreground. `subscribe` reports whether the app is in the foreground and returns an unsubscribe. Only the first `subscribe` is used while the component is mounted.

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
