# HTTP API

The complete route table exposed by `createSyncApp`. Every route's logic is also callable directly — see [Programmatic API](/reference/programmatic-api).

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/status` | none | Liveness — `{ "status": "ok" }`. |
| `GET` | `/info` | none | `{ name, protocolVersion, realtime, …info }` — clients read this during connect. |
| `POST` | `/auth/register` | Bearer **app password** | Body `{ appName, clientId, clientName }` — trade the app's password for a per-client token → `{ clientId, token }`. |
| `GET` | `/auth/check` | Bearer **token** | Validate a token → `{ ok, client }`. |
| `GET` | `/realtime` | token (`?token=` or Bearer) | WebSocket upgrade for invalidation pushes. |
| `POST` | `/sync/push` | Bearer **token** | Upsert documents (last-write-wins). |
| `GET` | `/sync/pull?collection=&since=` | Bearer **token** | Documents changed since a timestamp. |
| `GET` | `/sync/pull?collection=&id=` | Bearer **token** | A single document by id. |
| `GET` | `/sync/blobs` | Bearer **token** | Authoritative set of stored blob hashes. |
| `PUT` | `/sync/blobs/:hash` | Bearer **token** | Upload blob bytes (`:hash` = SHA-256 of body). |
| `GET` | `/sync/blobs/:hash` | Bearer **token** | Download blob bytes. |

::: warning No remote-wipe route
There is intentionally **no** HTTP route to wipe the database — it would let any single client credential erase the whole group's data. Wiping is operator-only and per-app, via the exported [`wipeAllDocumentsViaApi` / `wipeAllBlobsViaApi`](/reference/programmatic-api) functions.
:::

All authenticated routes are **tenant-scoped**: the token resolves to the client row created at registration, and that row's `appName` bounds every read, write, blob, and realtime room. Two apps on the same server can never see each other's data. See [Authentication](/server/auth).

## `GET /info`

Read by clients during connect, and by the realtime layer to decide whether to open a socket.

```json
{
  "name": "Our Household",
  "protocolVersion": 3,
  "realtime": true,
  "mcp": true
}
```

`name` comes from `SERVER_NAME`; `realtime` reflects `ENABLE_REALTIME === "true"`. Any extra fields (like `mcp`) come from the `info` option passed to `createSyncApp`. The reserved keys `name`, `protocolVersion`, and `realtime` can't be overridden.

## `POST /auth/register`

Authenticated with the **app's password** as a Bearer token. Body:

```json
{ "appName": "myapp", "clientId": "cl-abc123", "clientName": "Alice's laptop" }
```

Returns:

```json
{ "clientId": "cl-abc123", "token": "pact_V1StGXR8…" }
```

`appName` must match `[a-z0-9][a-z0-9_-]{0,63}` and name an app in the server's roster; the returned token is bound to that app, so no later request carries the app name. An unknown app returns the same `401` as a wrong password. Re-registering the same `clientId` rotates the token but keeps the client's identity. See [Authentication](/server/auth).

## `GET /sync/pull`

Two modes, selected by query params (both require a `collection`):

- `?collection=recipes&since=<iso>` — every document in the collection changed at or after the timestamp.
- `?collection=recipes&id=r-123` — a single document by id.

Incoming documents are reconciled client-side with [last-write-wins](/guide/sync#last-write-wins-both-directions).

## `POST /sync/push`

Upserts a batch of documents into D1. The server applies last-write-wins per document:

```sql
ON CONFLICT (app_name, collection, id)
  DO UPDATE SET ... WHERE excluded.updated_at >= documents.updated_at
```

Documents authored by `_local` are rejected — claim an identity first (see [Authors & Identity](/guide/authors-identity)). If realtime is enabled, accepted writes broadcast an `invalidate` to connected sockets via `waitUntil`.

## `GET /realtime`

A WebSocket upgrade. Because browser WebSocket APIs can't set headers, the token may be supplied as `?token=` **or** as a Bearer header (native clients). Returns `404` when `ENABLE_REALTIME` isn't `"true"`. Messages are invalidations:

```json
{ "type": "invalidate", "collections": ["recipes", "groceryItems"] }
```

See [Realtime](/guide/realtime) for connection behavior.

## Blob routes

| Route | Behavior |
|-------|----------|
| `GET /sync/blobs` | Returns the authoritative set of stored blob hashes. Clients diff this against their local cache. |
| `PUT /sync/blobs/:hash` | Uploads bytes. `:hash` must be the SHA-256 hex digest of the request body. Idempotent. |
| `GET /sync/blobs/:hash` | Downloads the bytes for a hash. |

See [Blobs](/guide/blobs) for the content-addressing model.
