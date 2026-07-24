#  Pact

A general purpose client library for document-based data storage. Local-only by default, with sync and realtime capabilities built in. 

```
npm install @a16n/pact-client
```

Pact deliberately trades generality for simplicity:

- **A small, high-trust group.** One server per app group (e.g. a household). Auth is one shared app password traded for per-client tokens; there's no per-document access control.
- **Last-write-wins is good enough.** Conflicts resolve by `updatedAt`. No CRDTs, no merge UIs.
- **Schemas are required, and owned by you.** The collection definitions you hand the store *are* the set of collections that exist — writes validate against them, and undefined collections are rejected.

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

### Reacting to changes

Every mutation — local writes, pulled changes from other devices, blob activity — emits a `change` event with the collection that changed. Hang your UI invalidation off it:

```ts
store.on('change', (collection) => {
  // re-read whatever your UI shows from that collection
});
```

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

If your app is like most apps, it probably needs to store binary data - images, video, pdfs etc. Blobs are content-addressed: the key is the SHA-256 of the bytes, so writes are idempotent and dedupe is automatic. Pass a `BlobAdapter` as `blobs` when creating the store, and declare a `blobHashes` extractor so pact knows which blobs your documents reference:

```ts
const store = await Store.create({
  adapter: databaseAdapter,
  blobs: myBlobAdapter, // a BlobAdapter — recipes provided, or implement the 7-method interface
  collections: [photos],
  blobHashes: blobFields({ photos: ['imageHash'] }), // which fields hold blob references
});

// Write bytes, reference them from a document by hash
const hash = await store.blobs.write(jpegBytes, 'image/jpeg');
await store.collection('photos').create({ caption: 'Sunset', imageHash: hash });

// Render it
const uri = store.blobs.uri(hash); // e.g. file://… — null if not local yet

// Syncing (with a registered server)
await store.blobs.push();           // upload blobs the server doesn't have
await store.blobs.pullReferenced(); // download blobs your docs reference but you don't hold
await store.blobs.prune();          // locally delete blobs no live doc references
```

The `blobHashes` extractor is what makes `pullReferenced` and `prune` possible — without it pact can't tell a referenced blob from an orphan. `blobFields` covers flat fields; write the function by hand for nested references.

## What you probably don't need to know

### Backups

Pact can pack every document (and optionally blobs) into a single portable archive, independent of any server:

```ts
const bytes = await store.backup.create();          // persist however you like
await store.backup.restore(bytes);                  // merge (last-write-wins)
await store.backup.restore(bytes, { mode: 'replace' });
```

### End-to-end encryption

Pass `encryption: { cipher }` when creating the store and domain fields are sealed into ciphertext — at rest locally and on the sync wire; the server only ever sees base sync fields (ids, timestamps, authors) plus the envelope:

```ts
const key = await deriveEncryptionKey(passphrase, 'myapp');
const store = await Store.create({
  adapter: databaseAdapter,
  collections: [todos],
  encryption: { cipher: createWebCryptoCipher(key) },
});
```

Wrong keys fail fast at startup. `createWebCryptoCipher` covers Node/web/Workers; React Native apps inject their own two-method `DocCipher`. All clients of the app must hold the same key — losing it loses the server-side data. Key management lives under `store.encryption`.

### Seeds

`store.seed()` loads versioned reference data identically on every client without syncing it — system-authored docs that user edits always win over.

## License

UNLICENSED — published for the author's own projects; no rights granted for other use.
