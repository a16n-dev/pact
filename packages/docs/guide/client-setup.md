# Client Setup

The `Store` is the single entry point on the client, and it's all you need to build a **complete, offline-first app — no server required**. You construct it with a storage adapter, an optional blob adapter, and a domain config; it gives you optimistic local CRUD that, later, transparently syncs once you [add a server](/server/deployment).

This page covers step 1: a working client-only app. Connecting it to a server for collaboration is the [last section](#connecting-to-a-server) and a separate, additive step.

## Install

```bash
pnpm add @pact/client
```

## Create a Store

No server, no network — this is a fully working store on its own:

```ts
import { Store, InMemoryAdapter } from '@pact/client';

const store = await Store.create(
  new InMemoryAdapter(), // storage adapter (or a SQLite-backed adapter)
  null, // optional BlobAdapter (null for JSON-only)
  domain // StoreDomain: validate / migrator / collections / …
);
```

`Store.create` restores any persisted sync credentials from `_config/client` and the current author from `_config/author`, so once you *do* connect to a server, a **returning client reconnects and keeps its identity automatically**.

The arguments:

| Argument | Type | Purpose |
|----------|------|---------|
| adapter | `DatabaseAdapter` | Where documents are persisted. |
| blobAdapter | `BlobAdapter \| null` | Where binary blobs live locally. `null` opts out. |
| domain | `StoreDomain` | Your validation, migrations, collection list, seed rules. |

## The storage adapter

The adapter is the pluggable persistence layer. Pact ships an in-memory one; apps supply a SQLite-backed adapter; in-Worker code uses [`D1Adapter`](/server/mcp).

```ts
interface DatabaseAdapter {
  // CRUD over documents, keyed by (collection, id).
  // Pact calls these — you implement them against your storage engine.
}
```

| Adapter | Where it lives | Use it for |
|---------|----------------|------------|
| `InMemoryAdapter` | `@pact/client` | Tests, CLIs, ephemeral scratch stores. |
| SQLite-backed | Your app | Real persistence on device (mobile / desktop). |
| `D1Adapter` | `@pact/server` | Code running *inside* the Worker (agents, MCP tools). |

## The domain

`StoreDomain` is where the consuming package injects everything Pact deliberately doesn't own. **All fields are optional** — omit one and the Store skips that step.

```ts
interface StoreDomain {
  validate?: (collection: string, doc: unknown) => unknown; // throw to reject; typically a Zod parse
  migrator?: Migrator; // defaults to a no-op
  collections?: readonly string[]; // collections iterated by pushAll / pull-all
  isSeedDoc?: (doc: BaseDocument) => boolean; // which docs pushAll skips (see Seeds)
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>; // materialize the author as a doc
}
```

A realistic domain wires validation to Zod and lists the syncable collections:

```ts
import { z } from 'zod';

const recipeSchema = z.object({
  /* base fields + your fields */
});

const domain: StoreDomain = {
  collections: ['recipes', 'users', 'groceryItems'],
  validate: (collection, doc) => {
    if (collection === 'recipes') return recipeSchema.parse(doc);
    return doc;
  },
  migrator,
};
```

See [Migrations](/guide/migrations) for `migrator`, [Authors & Identity](/guide/authors-identity) for `onSetAuthor`, and [Seeds](/guide/seeds) for `isSeedDoc`.

## Reading and writing

`store.collection<T>(name)` returns a thin typed wrapper so you don't repeat the collection name:

```ts
const recipes = store.collection<Recipe>('recipes');

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

1. **Validate + stamp** `schemaVersion` (via the domain `validate` hook).
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

A fresh client has no credentials and writes under the `_local` author. To sync, it must register with a server (trading the shared password for a token) and claim an identity:

```ts
// 1. trade the server password for a per-client token (persisted in _config/client)
await store.registerClient(
  'https://sync.example.com', // server url
  serverPassword, // the shared server password
  "Alice's laptop" // display name for this client
);

// 2. claim an identity and rewrite any _local docs so they can sync
await store.setAuthor('us-alice');
await store.reassignLocalAuthor('us-alice');
```

`registerClient` returns `{ clientId, token }` and persists both — the token is long-lived, so subsequent `Store.create` calls reconnect automatically. Re-registering the same client rotates its token while keeping its identity.

Realtime needs no client flag. Once a server is configured, the client probes `GET /info` and opens a realtime socket automatically whenever the server advertises support — and stays silent when it doesn't.

Identity and the `_local` author are covered in depth in [Authors & Identity](/guide/authors-identity); the wire protocol is in [Sync](/guide/sync), and realtime in [Realtime](/guide/realtime).
