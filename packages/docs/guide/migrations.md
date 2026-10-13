# Migrations

Each collection has a migration chain, declared on its [collection definition](/guide/client-setup#the-domain). A document carries its `schemaVersion`; the Store's migrator walks it forward to the collection's current version as the document is read.

```ts
import { defineCollection } from '@a16n/pact-client';

const recipes = defineCollection({
  name: 'recipes',
  idPrefix: 'rcp',
  migrations: {
    current: 3,
    migrations: [
      { from: 1, to: 2, up: (doc) => ({ ...doc, servings: doc.servings ?? 1 }) },
      { from: 2, to: 3, up: (doc) => ({ ...doc, tags: doc.tags ?? [] }) },
    ],
  },
  schema: (base) => base.extend({ /* current shape */ }),
});
```

A collection without `migrations` sits at version 1 and every document is assumed already current. New writes are stamped with `current` for their collection.

## Migrate on read

Behind-version documents are upgraded **on every read** and lazily written back, so old shapes drain out of local storage over time. There's no batch migration step, no downtime, no "migrating…" screen — the upgrade rides along with normal access.

```
read recipe r-123 (schemaVersion: 1)
  → up 1→2  (add servings)
  → up 2→3  (add tags)
  → return doc at version 3, write it back
```

## The rules

- **Pure functions.** A migration's `up` can't read other collections or do IO. It receives one document and returns the next-version shape. This keeps migrations deterministic and runnable anywhere — including server-side.
- **Forward-incompat is loud.** A document at a `schemaVersion` *higher* than the build knows throws ("upgrade the app") rather than silently corrupting data. An old client will refuse to mangle a document written by a newer one.
- **One chain per collection.** Each collection declares its `current` version and the ordered `from → to` steps to reach it.

## The server never migrates

Migrations are a client concern only. The server stores document bodies opaquely — it can't see inside encrypted ones at all — and never transforms them on push. A document at any `schemaVersion` sits on the server as written; whichever client pulls it walks it forward on read. That's what lets clients on different builds coexist: each one migrates what it sees to the version it knows.

::: tip Versioning workflow
When you change a collection's shape:
1. Bump `current`.
2. Add a `{ from, to, up }` step from the previous version to the new one.
3. Stamp new writes at the new version (automatic — the Store reads `current`).
4. Ship. Old documents upgrade as they're read; the server normalizes on push.
:::
