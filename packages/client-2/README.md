# Pact client

A local-first document store with sync, realtime, collaborative text, blobs, migrations and end-to-end encryption. This is the client half of Pact 2; it talks to a Pact 2 server over the API in [`../server-2/api.md`](../server-2/api.md).

```
npm install @a16n/pact-client
```

Pact deliberately trades generality for simplicity:

- **A small, high-trust group.** One server, one app, everyone signed in shares all of its data. There is no per-document access control.
- **Merging is per field, by clock.** Every field carries a hybrid logical clock and the greater clock wins. Text fields are Yjs documents and merge character by character. There are no merge UIs.
- **Schemas are required, and owned by you.** The collection definitions you hand the store _are_ the set of collections that exist. Writes validate against them and undefined collections are rejected.

## What you definitely need to know

### Creating a store

```ts
import { Store, InMemoryAdapter } from '@a16n/pact-client';

const store = await Store.create({
  adapter: new InMemoryAdapter(),
  collections: [todos],
});
```

The `adapter` is where documents live. `InMemoryAdapter` is built in; [`recipes/adapters`](./recipes/adapters) has copyable implementations for Expo SQLite and IndexedDB. An adapter is dumb storage keyed by `(collection, id)`; see `DatabaseAdapter` to write your own.

### Defining collections

```ts
import { z } from 'zod';
import { defineCollection } from '@a16n/pact-client';

const todos = defineCollection({
  name: 'todos',
  idPrefix: 'td',
  merge: 'field',
  schema: (base) =>
    base.extend({
      title: z.string().min(1),
      done: z.boolean().default(false),
    }),
});
```

The schema extends a base of `id`, `createdAt`, `updatedAt` and `deletedAt`. Every id carries the collection's prefix (`td-Ab3xY9kQz2`), enforced at runtime and in the type system. See `CollectionConfig` for `key`, `synced`, `merge` and `migrations`.

### Reading and writing

```ts
const col = store.collection('todos');

const todo = await col.create({ title: 'Do laundry' }); // id generated; pass `id` to choose
await col.get('td-123'); // null when missing or deleted
await col.list();
await col.update('td-123', { done: true }); // partial: omitted fields keep their value and clock
await col.upsert({ id: 'td-123', title: 'Do laundry' });
await col.delete('td-123'); // soft: the tombstone syncs
```

`create`, `update` and `delete` have `...Many` forms, and `get` and `list` take `{ includeDeleted: true }`. `updatedAt` is derived from the newest field clock and is never stored.

### Reacting to changes

Every mutation, whether a local write, a merge pulled from another device or blob activity, emits `change` with the collection name:

```ts
store.on('change', (collection) => {
  // re-read whatever the UI shows from that collection
});
```

## Syncing

### Signing in

Sign-in is OAuth with PKCE against the server's own login page. The store builds the URL and finishes the exchange; your app opens the browser and brings the redirect back:

```ts
const { authorizeUrl } = await store.sync.beginSignIn({
  url: 'https://sync.example.com',
  appId: 'myapp',
  deviceName: "Alice's laptop",
  redirectUri: 'https://myapp.example.com/auth/callback',
});
// open authorizeUrl; on the callback page read `code` and `state` from the URL
const result = await store.sync.completeSignIn({ code, state });
```

[`recipes/sign-in`](./recipes/sign-in) has the browser and Expo versions of that. The pending sign-in survives a page reload, so a web app can finish on a different page load than it started on. The session persists; later launches validate the token and reconnect on their own.

### What happens after

- Writes are queued in a local outbox before any network call and pushed as they land. Writes made before sign-in are pushed on the first drain after it.
- Changes from other devices arrive over a WebSocket and are merged in. Reads also trigger a throttled pull, and `store.sync.pull()` does one on demand.
- `store.sync.drain()` retries anything the server has not accepted yet; `pending()` says how much that is.
- A revoked token, or a 401 from anywhere, clears the session and emits `signedOut`:

```ts
store.on('signedOut', () => showSignIn());
```

`store.sync.session()`, `registration()` and `credentials()` describe the current session; `credentials()` is also what points an OpenAI-compatible SDK at `<url>/ai`.

## Collaborative text

Declare a text field with `yText()` from the `@a16n/pact-client/yjs` subpath. Reads see a `string`; writes may pass a `string`, which replaces the whole text; and `collection.text(id, field)` hands out the live `Y.Text` for an editor to bind to:

```ts
import { yText } from '@a16n/pact-client/yjs';

const notes = defineCollection({
  name: 'notes',
  idPrefix: 'nt',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), body: yText() }),
});

const body = await store.collection('notes').text('nt-1', 'body');
body.insert(0, 'Hello');
```

Every transaction on that `Y.Text` is persisted immediately and pushed after a one-second quiet period. Edits from other devices land in the same instance. The `yjs` engine lives behind that subpath, so a store with no text fields never bundles it.

## What you might need to know

### Migrations

```ts
const todos = defineCollection({
  name: 'todos',
  idPrefix: 'td',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), completed: z.boolean() }),
  migrations: {
    current: 2,
    migrations: [{ from: 1, to: 2, up: (fields) => ({ ...fields, completed: fields.done }) }],
  },
});
```

Documents upgrade lazily as they are read. A field that survives a migration keeps its clock. Versions written by a newer build than this one are held aside, hidden from reads, until the app upgrades; `pull()` reports them under `held`.

### Merge modes

Every collection declares how concurrent edits to the same record combine, and the choice cannot be changed once data exists.

`merge: 'field'` gives each field its own clock, so edits to different fields from different devices both survive. Use it for most records.

`merge: 'document'` gives the whole record one clock, so the latest write wins wholesale. Use it for records that only make sense as a unit. Document-level collections cannot have text fields.

### Blobs

Pass a `BlobAdapter` as `blobs` and declare which fields hold blob hashes:

```ts
const store = await Store.create({
  adapter,
  blobs: myBlobAdapter,
  collections: [photos],
  blobHashes: blobFields({ photos: ['imageHash'] }),
});

const hash = await store.blobs.write(jpegBytes, 'image/jpeg');
await store.collection('photos').create({ caption: 'Sunset', imageHash: hash });
store.blobs.uri(hash); // renderable URI, or null until pulled

await store.blobs.push(); // upload what the server lacks
await store.blobs.pullReferenced(); // download what documents reference
await store.blobs.prune(); // delete local blobs nothing references
```

Blobs are content-addressed and capped at 50 MB. They are shared by everyone in the app and never encrypted.

### Backups

```ts
const bytes = await store.backup.create();
await store.backup.restore(bytes); // merge, by the same rules as sync
await store.backup.restore(bytes, { mode: 'replace' });
```

## What you probably don't need to know

### End-to-end encryption

```ts
const key = await deriveEncryptionKey(passphrase, 'myapp');
const store = await Store.create({
  adapter,
  collections: [todos],
  encryption: { cipher: createWebCryptoCipher(key) },
});
```

Records are sealed at rest and on the wire; the server sees only `collection`, `id` and the clock. A wrong key fails at startup on any install that already holds data. Every client of the app must hold the same key: a version sealed under another key is skipped on pull, so clients with different keys never see each other's documents. To turn encryption on for existing data, call `store.encryption.encryptLocal()` and then `store.sync.push()`.

### Indexes

```ts
const todos = defineCollection({ ... }).withIndexes({
  done: (doc) => doc.done,
  tags: (doc) => doc.tags, // multi-valued
});

await store.collection('todos').listByIndex('done', true);
```

Equality lookups only, rebuilt in memory on every `Store.create`. Most of the time `list()` and a filter is enough.

### Document limits

A document is at most 1 MB on the wire, text state included; a write over that fails with an error naming the document and is never queued. Collection keys and ids are 1 to 256 characters.

## License

MIT
