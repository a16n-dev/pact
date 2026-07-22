# Client Setup

The `Store` is the single entry point on the client, and it's all you need to build a **complete, offline-first app — no server required**. You construct it with a storage adapter, an optional blob adapter, and a domain config; it gives you optimistic local CRUD that, later, transparently syncs once you [add a server](/server/deployment).

This page covers step 1: a working client-only app. Connecting it to a server for collaboration is the [last section](#connecting-to-a-server) and a separate, additive step.

## Install

```bash
pnpm add @a16n/pact-client
```

## Create a Store

No server, no network — this is a fully working store on its own:

```ts
import { Store, InMemoryAdapter } from '@a16n/pact-client';

const store = await Store.create(
  new InMemoryAdapter(), // storage adapter (or a SQLite-backed adapter)
  null, // optional BlobAdapter (null for JSON-only)
  domain // StoreDomain: your collection definitions + hooks
);
```

`Store.create` restores any persisted sync credentials from `_config/client` and the current author from `_config/author`, so once you *do* connect to a server, a **returning client reconnects and keeps its identity automatically**.

The arguments:

| Argument | Type | Purpose |
|----------|------|---------|
| adapter | `DatabaseAdapter` | Where documents are persisted. |
| blobAdapter | `BlobAdapter \| null` | Where binary blobs live locally. `null` opts out. |
| domain | `StoreDomain` | Your collection definitions (schemas, migrations, id prefixes) + hooks. |

## The storage adapter

The adapter is the pluggable persistence layer. Pact ships an in-memory one; apps supply a SQLite-backed adapter.

```ts
interface DatabaseAdapter {
  // CRUD over documents, keyed by (collection, id).
  // Pact calls these — you implement them against your storage engine.
}
```

| Adapter | Where it lives | Use it for |
|---------|----------------|------------|
| `InMemoryAdapter` | `@a16n/pact-client` | Tests, CLIs, ephemeral scratch stores. |
| SQLite-backed | Your app | Real persistence on device (mobile / desktop). |

## The domain

`StoreDomain` is where the consuming package injects everything Pact deliberately doesn't own. Its heart is `collections` — **the schemas you provide define which collections exist**. Each collection is declared once with `defineCollection` (name, id prefix, Zod schema, migration chain), and the Store derives everything from that list: write validation, the migrator, id parsing, and the sync enumeration. Reading or writing a collection that isn't defined throws.

```ts
interface StoreDomain {
  collections: readonly CollectionDefinition[]; // required — the schemas ARE the collections
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>; // materialize the author as a doc
  blobHashes?: (collection: string, doc: BaseDocument) => Iterable<string>; // blob refs for GC / pull (see Blobs)
  encryption?: { cipher: DocCipher }; // optional E2E encryption (see Encryption)
}
```

A realistic domain defines each collection's schema (and, over time, its migrations):

```ts
import { z } from 'zod';
import { defineCollection, type StoreDomain } from '@a16n/pact-client';

const recipes = defineCollection({
  name: 'recipes',
  idPrefix: 'rcp', // ids look like rcp-x7k2m9qp4w; also powers parseId
  schema: (base) =>
    // `base` already carries the audit fields and the prefix-checked id.
    base.extend({
      title: z.string().min(1),
      servings: z.number().int().positive(),
    }),
});

const drafts = defineCollection({
  name: 'drafts',
  idPrefix: 'drf',
  synced: false, // validated + migrated, but never leaves the device
  schema: (base) => base.extend({ body: z.string() }),
});

const domain: StoreDomain = { collections: [recipes, drafts] };
```

Declaring the schemas here also makes `store.collection('recipes')` fully typed: the name is narrowed to your defined collections and the document type is inferred from the schema.

See [Migrations](/guide/migrations) for per-collection `migrations`, [Authors & Identity](/guide/authors-identity) for `onSetAuthor`, [Blobs](/guide/blobs#declaring-which-fields-hold-blob-hashes) for `blobHashes`, and [Encryption](/guide/encryption) for `encryption`.

## Reading and writing

`store.collection(name)` returns a thin typed wrapper so you don't repeat the collection name. The name is type-narrowed to your defined collections and the document type comes from that collection's schema:

```ts
const recipes = store.collection('recipes');

// reads (tombstones filtered out)
await recipes.get(id);
await recipes.getMany(ids);
await recipes.list();

// writes (optimistic)
await recipes.create(id, input);
await recipes.update(id, partial);
await recipes.delete(id);

// batch writes
await recipes.createMany(items);
await recipes.updateMany(updates);
await recipes.deleteMany(ids);

// explicit sync
await recipes.pull(); // pull this collection's changes from the server
await recipes.pullDocument(id); // pull a single doc by id
```

## Optimistic writes

Every mutation (`create`, `update`, `delete`, and their `*Many` variants) follows the same path:

1. **Validate + stamp** `schemaVersion` (a parse against the collection's schema).
2. **Write** to the local adapter.
3. **Emit** a `change` event so the UI can re-read.
4. **Fire-and-forget push** to the server. Failures are swallowed — the write is already durable locally and will be re-sent by `pushAll`.

This means writes **never block on the network and always succeed offline**.

```ts
store.on('change', () => {
  // re-read the collections your UI is showing
});
```

## Connecting to a server

This is **step 2** — additive, and entirely optional until you need it. Everything above works without it; nothing above changes when you add it.

A fresh client has no credentials and writes under the `_local` author. To sync, it must register with a server (trading its app's password for a token) and claim an identity. The server is [multi-tenant](/server/auth) — `appName` says which app on it this client belongs to:

```ts
// 1. trade the app password for a per-client token (persisted in _config/client)
await store.registerClient(
  'https://sync.example.com', // server url
  appPassword, // this app's password on the server
  'myapp', // which app on the server this client belongs to
  "Alice's laptop" // display name for this client
);

// 2. claim an identity and rewrite any _local docs so they can sync
await store.setAuthor('us-alice');
await store.reassignLocalAuthor('us-alice');
```

`registerClient` returns `{ clientId, token }` and persists both — the token is long-lived, so subsequent `Store.create` calls reconnect automatically. Re-registering the same client rotates its token while keeping its identity.

Realtime needs no client flag. Once a server is configured, the client probes `GET /info` and opens a realtime socket automatically whenever the server advertises support — and stays silent when it doesn't.

Identity and the `_local` author are covered in depth in [Authors & Identity](/guide/authors-identity); the wire protocol is in [Sync](/guide/sync), and realtime in [Realtime](/guide/realtime).
