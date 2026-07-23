#  Pact

A general purpose client library for document-based data storage. Local-only by default, with sync and realtime capabilities built in. 

## What you definitely need to know

### Creating a store

Pact uses a `store` which you can interact with. Create a store like so:

```ts
import { Store } from "@a16n/pact-client";

const databaseAdapter = new InMemoryAdapter();

const store = await Store.create({
    adapter: databaseAdapter,
    collections: [todos]
});

```

The `adapter` lets pact use the storage backend of your choice. Recipes are provided here that you can copy+paste for common storage backends (localStorage, indexedDb, sqlite, file system, ...). 

Alternatively implement your own: see `DatabaseAdapter` for a full reference. Everything else a store can take (blobs, encryption, hooks) is on `StoreOptions`.

### Creating collections

Now you'll need some collections, to continue our earlier example:

```ts
const todos = defineCollection({
  name: 'todos',
  idPrefix: 'td',
  schema: (base) =>
    base.extend({
      title: z.string().min(1),
      done: z.boolean().default(false),
    }),
});
```

The schema can be any zod schema extending the base schema. Every document id carries the collection's prefix (`td-Ab3xY9kQz2`) — enforced at runtime *and* in the type system, so passing a todo id where a recipe id belongs is a compile error. See `CollectionConfig` for the full set of options.

### All the CRUD you'd expect

Documents are read and written through a collection handle, fully typed from the schema:

```ts
const todosCollection = store.collection('todos');

// Create one — the id is generated for you (pass `id` to choose your own)
const todo = await todosCollection.create({ title: 'Do laundry' })

// Find one
todosCollection.get('td-123') // returns null if not found

// List all
todosCollection.list()

// Update one — a partial merge: fields you omit are left alone
todosCollection.update('td-123', { title: 'Do laundry' })

// Create-or-update by id
todosCollection.upsert({ id: 'td-123', title: 'Do laundry' })

// Delete one (soft: a tombstone remains, so the delete syncs)
todosCollection.delete('td-123')
```

Each of `create`/`update`/`delete` has a `...Many` batch form, `get`/`list` accept `{ includeDeleted: true }` to see tombstones, and `pull`/`pullAll` fetch fresh from a sync server. See `Collection` for the full reference.

That's all you strictly need to know. Read on for more features that you'll probably need

## What you might need to know

### Migrations

Sooner or later you'll want to change a schema. Pact supports migrations, which do exactly this.

We actually wanted `done` to be called `completed`, so we can add a migration to rename the field:

```ts
const todos = defineCollection({
  name: 'todos',
  idPrefix: 'td',
  schema: (base) =>
    base.extend({
      title: z.string().min(1),
      completed: z.boolean().default(false),
    }),
  migrations: {
    current: 2,
    migrations: [{
      from: 1, 
      to: 2,
      up: (doc) => {
        doc.completed = doc.done
        return doc;
      }
    }]
  } 
});
```

Old documents upgrade lazily as they're read. Note that you don't always need a migration. If you add a new field with a default value, they will still parse correctly

### Syncing

Point the store at a pact server and the same CRUD code syncs, with offline writes queued durably:

```ts
await store.sync.register(url, appPassword, 'myapp', "Alice's laptop"); // once per install
await store.author.set('us-alice');          // claim who this device writes as
await store.author.reassignLocal('us-alice'); // adopt any pre-identity writes

await store.sync.push();      // drain queued writes, push everything
await todosCollection.pullAll(); // pull everyone else's changes
```

Registration persists, so future launches reconnect automatically — and when the server advertises realtime, changes from other devices arrive over a WebSocket with no extra code. Everything server-related lives under `store.sync`; identity under `store.author`.

### Binary blobs

If your app is like most apps, it probably needs to store binary data - images, video, pdfs etc. Pass a `BlobAdapter` as `blobs` when creating the store, reference blobs from documents by content hash, and declare a `blobHashes` extractor so pact knows which blobs are referenced — that powers `store.blobs.prune()` (local garbage collection) and pulling exactly the blobs your documents need.

## What you probably don't need to know

### Backups

Pact can pack every document (and optionally blobs) into a single portable archive, independent of any server:

```ts
const bytes = await store.backup.create();          // persist however you like
await store.backup.restore(bytes);                  // merge (last-write-wins)
await store.backup.restore(bytes, { mode: 'replace' });
```

### End-to-end encryption

Pass `encryption: { cipher }` when creating the store and domain fields are sealed into ciphertext — at rest locally and on the sync wire; the server only ever sees base sync fields plus the envelope. Key management lives under `store.encryption`.

### Seeds

`store.seed()` loads versioned reference data identically on every client without syncing it — system-authored docs that user edits always win over.
