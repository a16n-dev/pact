# Realtime

When `realtime: true` and the server has the feature enabled, the client opens a WebSocket to `/realtime`. The server doesn't push document *bodies* — it pushes lightweight **invalidations**, and the client pulls what changed.

## The invalidation model

A message on the wire looks like this:

```json
{ "type": "invalidate", "collections": ["recipes", "groceryItems"] }
```

On receiving one, the client **pulls the named collections** (the same [pull](/guide/sync) path as everything else). The WebSocket is a *notification channel*, not a data channel — bodies always travel over plain HTTP with last-write-wins. This keeps the realtime layer tiny and means a missed message is never a missed write: the next pull reconciles it.

```
client A writes recipe ──▶ POST /sync/push ──▶ server upserts into D1
                                                     │
                                                     ▼ waitUntil (never blocks the response)
                                            RealtimeDO broadcasts
                                          { invalidate: ["recipes"] }
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          ▼                           ▼                          ▼
                     client B pulls             client C pulls            agent pulls
                       "recipes"                  "recipes"                "recipes"
```

## Connection behavior

The client connection:

- **Probes `GET /info` first** and silently no-ops if the server hasn't enabled realtime. Turning realtime off server-side is safe — clients just stop opening sockets.
- **Reconnects with exponential backoff**, capped at 30s.
- **On (re)connect, pulls all registered collections** to backfill anything missed while offline.
- **Authenticates via `?token=` query param** — browser WebSocket APIs can't set an `Authorization` header. Native clients can use either the query param or a Bearer header.

::: tip Backfill on reconnect is the safety net
Because every reconnect triggers a full pull of registered collections, the realtime channel can drop messages, hibernate, or disconnect for an hour and the client still converges the moment it reconnects. Realtime makes convergence *fast*; pull makes it *correct*.
:::

## Server side: one Durable Object

Fan-out is a single Durable Object (`RealtimeDO`) using **hibernatable WebSockets**. Accepted writes on the push path broadcast to all connected sockets via `waitUntil`, so broadcasting **never blocks the response** to the writer.

Hibernation means the Durable Object evicts from memory while sockets stay open, and wakes only when there's a message to fan out — so idle connections cost nothing. When realtime is gated off, the Durable Object stays deployed but idle.

You enable it with two pieces of deployment config — the `ENABLE_REALTIME` var and the `RealtimeDO` binding. See [Deployment](/server/deployment) and [Building Blocks](/server/building-blocks#realtimedo).

## Enabling it on the client

```ts
const store = await Store.create(adapter, blobAdapter, domain, {
  realtime: true,
});
```

That's the whole client opt-in. If the server reports realtime disabled via `/info`, the flag is a harmless no-op.
