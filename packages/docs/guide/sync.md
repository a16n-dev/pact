# Sync Protocol

Sync is HTTP: **pull-based for reads, push-based for writes**, with last-write-wins reconciliation throughout. It's deliberately boring — there's no session, no negotiation, no merge protocol. Just upserts and timestamp comparisons.

## The four operations

| Operation | What it does |
|-----------|--------------|
| optimistic push | Every mutation fire-and-forgets the changed docs to `POST /sync/push`. |
| `store.pushAll()` | Re-sends everything (minus untouched seeds and `_` collections) — the offline-backlog flush. |
| `store.pull(collection)` | Requests docs changed since this collection's last-sync timestamp, LWW-merges them locally, advances the timestamp. |
| `store.pullDocument(collection, id)` | Pulls a single doc (LWW against the local copy). |

With [encryption](/guide/encryption) enabled, the document body in every push/pull is the sealed envelope (base fields + one ciphertext string) — the protocol itself is unchanged, since the server never inspects `data`.

## Push: writes flow out optimistically

You never call push explicitly in the common case. Each mutation already fire-and-forgets its changed documents to the server (step 4 of an [optimistic write](/guide/client-setup#optimistic-writes)). If the network is down, the failure is swallowed — the write is durable locally, and `pushAll()` will re-send it later.

`pushAll()` is the **backlog flush**: it re-sends everything that should sync, skipping untouched [seeds](/guide/seeds) and the internal `_` collections. Call it on reconnect, on app foreground, or on a timer.

```ts
await store.pushAll(); // flush anything that didn't make it out earlier
```

::: warning `_local` writes can't push
The server rejects any document authored by `_local`. Claim an identity and call `reassignLocalAuthor` first — see [Authors & Identity](/guide/authors-identity).
:::

## Pull: reads flow in by timestamp

`store.pull(collection)` asks the server for everything in that collection changed since the cursor stored in `_sync_meta`, merges the results, and advances the cursor. Only the delta crosses the wire.

```ts
await store.pull('recipes'); // changed since last pull
await store.pullDocument('recipes', 'r-123'); // one doc, on demand
```

## Last-write-wins, both directions

The whole conflict story is one comparison on `updatedAt`:

- **On pull**, an incoming document older than the local copy is **skipped** — so a not-yet-pushed local edit isn't clobbered by a stale server version.
- **On the server's upsert**, the same rule, in SQL:

  ```sql
  ON CONFLICT ... WHERE excluded.updated_at >= documents.updated_at
  ```

- **Ties go to the incoming doc** (server copy on pull, the pushed copy on push).

That symmetry is what makes the protocol safe to run in any order, any number of times. Re-pushing or re-pulling is idempotent; a flaky connection just means things converge a little later.

## When to call what

| Situation | Call |
|-----------|------|
| Normal mutation | nothing — push is automatic |
| Came back online | `store.pushAll()` then pull the collections you care about |
| Opening a screen | `store.pull(collection)` for freshness |
| Realtime says a collection changed | handled for you — see [Realtime](/guide/realtime) |
| Need one specific doc now | `store.pullDocument(collection, id)` |
