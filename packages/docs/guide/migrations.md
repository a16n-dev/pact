# Migrations

Each collection has a migration chain. A document carries its `schemaVersion`; the `Migrator` walks it forward to the collection's current version as the document is read.

```ts
import { Migrator } from '@a16n/pact-client';

const migrator = new Migrator({
  recipes: {
    current: 3,
    migrations: [
      { from: 1, to: 2, up: (doc) => ({ ...doc, servings: doc.servings ?? 1 }) },
      { from: 2, to: 3, up: (doc) => ({ ...doc, tags: doc.tags ?? [] }) },
    ],
  },
});
```

Pass the migrator into your [domain](/guide/client-setup#the-domain) (`domain.migrator`). If you omit it, the Store uses a no-op migrator and every document is assumed already current.

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

## Keeping client and server aligned

The server can run the **same chain** on the push path via the `migrate` hook, so documents are normalized to a known version as they land in D1:

```ts
import { createSyncApp } from '@a16n/pact-server';

export default createSyncApp({
  hooks: {
    migrate: (collection, data) => myMigrator.migrate(collection, data),
  },
});
```

Because the `up` functions are pure, the exact same `Migrator` instance can be shared between client and server builds — there's only ever one definition of how a collection evolves.

::: tip Versioning workflow
When you change a collection's shape:
1. Bump `current`.
2. Add a `{ from, to, up }` step from the previous version to the new one.
3. Stamp new writes at the new version (automatic — the Store reads `current`).
4. Ship. Old documents upgrade as they're read; the server normalizes on push.
:::
