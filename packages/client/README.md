# @a16n/pact-client

The client half of **Pact** — an intentionally simple architecture for building **local-first apps** that can grow into **realtime collaboration** for a small, high-trust group of people and agents.

Everything revolves around a `Store`: local CRUD over JSON documents with pluggable storage, optimistic writes that never block on the network, and — once you point it at a [pact server](https://github.com/a16n-dev/pact) — background sync, realtime invalidations, blobs, and optional end-to-end encryption. Your app code is identical with or without a server.

```
npm install @a16n/pact-client
```

## Design assumptions

Pact deliberately trades generality for simplicity:

- **A small, high-trust group.** One server per app group (e.g. a household). Auth is one shared app password traded for per-client tokens; there's no per-document access control.
- **Last-write-wins is good enough.** Conflicts resolve by `updatedAt`. No CRDTs, no merge UIs.
- **Schemas are required, and owned by you.** Every collection is declared with a Zod schema (plus id prefix and migrations) via `defineCollection` — the set of definitions you hand the Store _is_ the set of collections that exist. Writes validate against them; undefined collections are rejected.

## Quick start (local-only)

```ts
import { z } from 'zod';
import { Store, InMemoryAdapter, defineCollection } from '@a16n/pact-client';

const recipesDef = defineCollection({
  name: 'recipes',
  idPrefix: 'rcp',
  schema: (base) => base.extend({ title: z.string(), servings: z.number() }),
});

const store = await Store.create({
  adapter: new InMemoryAdapter(),
  collections: [recipesDef],
});
await store.author.set('us-alice');

const recipes = store.collection('recipes'); // typed from the schema
const soup = await recipes.create({ title: 'Garlic soup', servings: 2 }); // id generated: 'rcp-…'
await recipes.update(soup.id, { servings: 4 });
const all = await recipes.list();

store.on('change', (collection) => {
  /* re-read what your UI shows */
});
```

`InMemoryAdapter` suits tests and CLIs; apps supply a `DatabaseAdapter` backed by SQLite (or anything that can store JSON docs by `(collection, id)`).

Every mutation validates, writes locally, emits `change`, and — when a server is configured — queues a durable background push. Writes always succeed offline.

## Adding sync

Deploy a pact server (multi-tenant: many unrelated apps can share one), then register:

```ts
await store.sync.register(
  'https://sync.example.com', // server url
  appPassword, // your app's password on that server
  'myapp', // which app on the server this client belongs to
  "Alice's laptop" // display name
);
await store.author.set('us-alice');
await store.author.reassignLocal('us-alice'); // adopt any pre-sync writes
```

The password is traded once for a long-lived token (persisted in local config); reconnection is automatic on future launches. Realtime is server-driven — when the server advertises it, the client opens a WebSocket and pulls collections as others change them. No app code changes.

## Optional end-to-end encryption

Domain fields can be sealed into a single ciphertext string — at rest locally **and** on the server; plaintext exists only in memory:

```ts
import { createWebCryptoCipher, deriveEncryptionKey } from '@a16n/pact-client';

const key = await deriveEncryptionKey(passphrase, 'myapp');
const store = await Store.create({
  adapter,
  collections: [recipesDef],
  encryption: { cipher: createWebCryptoCipher(key) },
});
```

Only the base sync fields (ids, timestamps, authors) stay cleartext. Wrong keys fail fast at startup. `createWebCryptoCipher` covers Node/web/Workers; React Native apps inject their own two-method `DocCipher`. All clients of the app must hold the key; losing it loses the server-side data.

## Also in the box

- **Blobs** — content-addressed binary storage (images etc.) with sync, reference-driven pull, and garbage collection (`store.blobs.prune`).
- **Migrations** — per-collection `schemaVersion` chains declared on each `defineCollection`; old docs upgrade on read.
- **Seeds** — versioned reference data every client loads identically without syncing it.
- **Backups** — self-contained archive export/restore (`store.backup.create` / `store.backup.restore`), merge or replace.
- **Outbox** — durable push queue: writes made offline drain automatically when connectivity returns.

## License

UNLICENSED — published for the author's own projects; no rights granted for other use.
