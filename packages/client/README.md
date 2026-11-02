# Pact client

A local-first document store with sync, realtime, collaborative text, blobs, migrations and end-to-end encryption. This is the client half of Pact; it talks to a Pact server over the API in [`../cloudflare-server/api.md`](../cloudflare-server/api.md).

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

Ids are random by default. A collection keyed by its content, such as ingredients deduplicated by name, sets `ids: 'slug'` instead: `create` then requires an `id` (`in-garlic`), so every device that adds "garlic" writes the same document. How the slug is built is up to the app. Pact only checks the id's shape and length.

### Reading and writing

```ts
const col = store.collection('todos');

const todo = await col.create({ title: 'Do laundry' }); // id generated; pass `id` to choose
await col.get('td-123'); // null when missing or deleted
await col.list();
await col.update('td-123', { done: true }); // partial: omitted fields keep their value and clock
await col.upsert({ id: 'td-123', title: 'Do laundry' });
await col.getOrCreate({ id: 'td-123', title: 'Do laundry' }); // the existing doc, untouched, or a new one
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

### AI

A signed-in store can run models through the server's AI routes:

```ts
const image = await store.ai.image({
  model: 'openai/gpt-image-1',
  prompt: 'A single brown onion on a transparent background',
  background: 'transparent',
  output: { width: 256, height: 256, format: 'webp' },
});
const hash = await store.blobs.write(image.bytes, image.mimeType);

const answers = await store.ai.decide({
  model: 'typesafe/jev',
  state: { item: 'brown onion', ingredient: 'onion' },
  questions: {
    matches: { type: 'noul', instructions: 'Can the item stand in for the ingredient?' },
  },
});
```

Both take `{ signal }` as a second argument to cancel the request. For chat, point any OpenAI-compatible SDK at `<server>/ai/compat` with the token from `store.sync.credentials()` as its API key. Signed out, these throw `SyncError` with the code `signed_out`.

### Background tasks

For slow work, such as an AI call, whose result has to land in documents later. A task syncs like a document, survives reloads, and runs on one signed-in device at a time. If that device disappears, another one takes over within about 90 seconds.

```ts
const parseNote = defineTask({
  name: 'parse',
  input: z.object({ slotId: z.string(), note: z.string() }),
  run: (input, { signal }) =>
    store.ai.decide({ model: 'typesafe/jev', state: input.note, questions }, { signal }),
  apply: async (input, answers) => {
    if (!(await store.collection('slots').get(input.slotId))) return;
    await store.collection('slots').update(input.slotId, { requirements: answers });
  },
});

store.tasks.register(parseNote);
await store.tasks.enqueue(parseNote, `parse:${slot.id}`, { slotId: slot.id, note });
const stop = store.tasks.watch(`parse:${slot.id}`, (state) => setParsing(state));
```

Enqueuing again under the same key replaces the task, and a run of the old input never applies. `apply` can run more than once for the same input, so it should set values rather than append, and do nothing when its documents are gone. A task with no handler on this device, or whose input this version's schema rejects, is left for a device that can run it. After 3 attempts (30 s and then 2 min apart by default) a task is `failed` until `store.tasks.retry(key)`. `watch` reports `null` once the task has finished or been cancelled.

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

Records are sealed at rest and on the wire; the server sees only `collection`, `id` and the clock. Each key is a lens: the store shows only the documents sealed under the active key, or the plain documents when no key is set. Documents in different lenses never interact, so the same id can hold a different document in each. A key the store has not seen before opens an empty lens.

```ts
await store.encryption.setKey(createWebCryptoCipher(otherKey)); // switch lens
await store.encryption.setKey(null); // back to the plain documents
await store.encryption.moveToKey(createWebCryptoCipher(newKey)); // re-key the current lens
```

Other lenses keep syncing while one is active, and a lens catches up on what it missed when it becomes active again.

`moveToKey` moves every live document in the current lens to another key (or `null` to decrypt), merging with whatever is already there, then switches to it. It returns how many documents moved and how many it had to leave behind, such as one the target holds at a newer schema version. A device that edits a moved document offline under the old key edits a deleted copy, so move while devices are in sync.

A custom `DocCipher` must implement `keyId()`, which names the lens on every device holding the key.

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
