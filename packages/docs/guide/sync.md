# Sync Protocol

Sync is HTTP: **pull-based for reads, push-based for writes**, with conflicts resolved entirely on the client. It's deliberately boring — there's no session, no negotiation, no server-side merge. The server stores one row per (document, client) and hands them all back; every client folds them with the same deterministic rule.

## The four operations

| Operation | What it does |
|-----------|--------------|
| optimistic push | Every mutation fire-and-forgets the changed docs to `POST /sync/push`. |
| `store.pushAll()` | Re-sends everything (minus untouched seeds and `_` collections) — the offline-backlog flush. |
| `store.pull(collection)` | Requests every row written since the app-wide pull cursor (all collections), folds siblings, merges the winners locally, advances the cursor. Returns the docs applied to `collection`. |
| `store.pullDocument(collection, id)` | Pulls every client's row for one doc, folds them, merges the winner against the local copy. |

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

## Pull: reads flow in by cursor

The pull cursor is **app-wide**: one server `seq` watermark covers every collection, stored in `_sync_meta/_app`. A pull asks for every row written after it, across all collections, folds the results, and advances the cursor. One paged request syncs the whole app; only the delta crosses the wire.

Rows for collections the running build doesn't define are skipped (the cursor still advances past them). When a build registers a collection the stored cursor didn't cover, the cursor restarts from 0 so that collection's history is backfilled — the fold is idempotent, so a re-pull is only bandwidth.

```ts
await store.pull('recipes'); // changed since last pull
await store.pullDocument('recipes', 'r-123'); // one doc, on demand
```

## Clients resolve conflicts; the server stores siblings

The server never decides a winner. Each client owns **its own row** per document (keyed `(collection, id, clientId)`) and a push only ever replaces that row. So two clients that edit the same document concurrently produce two rows — *siblings* — and the server returns both on pull.

Every client folds siblings with the same rule, so they all land on the same answer regardless of the order rows arrive:

- **Later `updatedAt` wins.**
- **An exact tie breaks on `clientId`** (higher wins), so the fold is deterministic across clients.
- The folded winner is then compared with the **local copy**: an incoming document older than it is skipped, so a not-yet-pushed local edit isn't clobbered by a stale server version. That comparison still gives ties to the incoming doc.

This is whole-document last-write-wins, same outcome the old server-side upsert produced — just computed where the schema lives. Field-level merge and CRDT text fields slot into the fold function later without changing the protocol.

### How many siblings?

One row per client that has ever written the document — bounded by the number of clients, not by the number of edits, since each push replaces that client's row. For a small group that's a handful of rows per document. (A pruning step, where a push tells the server which sibling rows it has folded so they can be dropped, is a straightforward later addition; the fold doesn't depend on it.)

Re-pushing or re-pulling is idempotent; a flaky connection just means things converge a little later.

## When to call what

| Situation | Call |
|-----------|------|
| Normal mutation | nothing — push is automatic |
| Came back online | `store.pushAll()` then pull the collections you care about |
| Opening a screen | `store.pull(collection)` for freshness |
| Realtime says a collection changed | handled for you — see [Realtime](/guide/realtime) |
| Need one specific doc now | `store.pullDocument(collection, id)` |
