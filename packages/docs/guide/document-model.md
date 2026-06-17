# The Document Model

Every document in Pact extends a `BaseDocument`. The consumer adds its own fields on top; Pact only ever reads the base fields.

```ts
interface BaseDocument {
  id: string;
  schemaVersion: number; // per-collection shape version; migrators upgrade old docs on read
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601 — the last-write-wins clock
  createdBy: string; // author id
  updatedBy: string; // author id
  deletedAt: string | null; // tombstone: null = live, ISO string = soft-deleted at this time
  deletedBy: string | null;
}
```

A `Recipe` in your domain is just this shape plus your fields:

```ts
interface Recipe extends BaseDocument {
  title: string;
  servings: number;
  tags: string[];
}
```

## Three consequences worth internalizing

### Soft deletes only

`delete` writes a tombstone (`deletedAt` set) rather than removing the row, so the deletion itself can sync. If deletes hard-removed rows, a peer would have no way to learn the row is gone.

- `get`, `list`, and `getMany` **filter tombstones out**.
- `getIncludingDeleted` **returns them** — seeding uses this to tell "the author deleted this seed" apart from "it never existed".

### `updatedAt` is the conflict clock

Both client and server resolve conflicts by keeping the higher `updatedAt`. Ties go to the incoming / server copy. This single rule is the whole conflict-resolution story — see [Sync](/guide/sync) for how it plays out in both directions.

### `schemaVersion` drives migrations

New writes are stamped with the collection's current version. Older documents are walked forward on read by the [Migrator](/guide/migrations). A document at a version *higher* than the running build knows is a loud error ("upgrade the app"), never a silent corruption.

## Collections

Documents live in named collections (`recipes`, `users`, …). Collection names prefixed with `_` are reserved for Pact's internal bookkeeping and are **never synced**:

| Collection | Holds |
|------------|-------|
| `_config` | The `client` doc (clientId, clientName, sync url, token) and the `author` doc (current author id). |
| `_sync_meta` | Per-collection "last pulled at" timestamp, used to request only what's changed. |

Because these never sync and never leave the device, restoring a client's identity across restarts is just reading `_config` back — see [Client Setup](/guide/client-setup).
