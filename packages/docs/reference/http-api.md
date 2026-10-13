# HTTP API

The complete route table exposed by `createSyncApp`. Every route's logic is also callable directly — see [Programmatic API](/reference/programmatic-api).

## Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/status` | none | Liveness — `{ "status": "ok" }`. |
| `GET` | `/info` | none | `{ name, protocolVersion, minProtocolVersion, realtime, …info }` — clients read this during connect. |
| `POST` | `/auth/register` | Bearer **app password** | Body `{ appName, clientId, clientName }` — trade the app's password for a per-client token → `{ clientId, token }`. |
| `POST` | `/apps` | Bearer **PROVISION_KEY** | Body `{ appName, password }` — create an app or rotate its password. `404` when `PROVISION_KEY` isn't configured. |
| `GET` | `/auth/check` | Bearer **token** | Validate a token → `{ ok, client }`. |
| `GET` | `/realtime` | token (`?token=` or Bearer) | WebSocket upgrade for invalidation pushes. |
| `POST` | `/sync/push` | Bearer **token** | Write documents into the calling client's own rows. |
| `GET` | `/sync/pull?cursor=` | Bearer **token** | Rows across all collections written after a server `seq` cursor (may include siblings). |
| `GET` | `/sync/pull?collection=&id=` | Bearer **token** | Every client's row for one document. |
| `GET` | `/sync/blobs` | Bearer **token** | Authoritative set of stored blob hashes. |
| `PUT` | `/sync/blobs/:hash` | Bearer **token** | Upload blob bytes (`:hash` = SHA-256 of body). |
| `GET` | `/sync/blobs/:hash` | Bearer **token** | Download blob bytes. |

::: warning No remote-wipe route
There is intentionally **no** HTTP route to wipe the database — it would let any single client credential erase the whole group's data. Wiping is operator-only and per-app, via the exported [`wipeAllDocumentsViaApi` / `wipeAllBlobsViaApi`](/reference/programmatic-api) functions.
:::

Every `/auth/*` and `/sync/*` request must carry **`X-Pact-Protocol: <version>`**. A missing header or a version outside `[minProtocolVersion, protocolVersion]` gets a `426` with `{ error, code: "protocol_unsupported", protocolVersion, minProtocolVersion }` before authentication runs. `/status`, `/info`, `/apps` and `/realtime` are exempt.

All authenticated routes are **tenant-scoped**: the token resolves to the client row created at registration, and that row's `appName` bounds every read, write, blob, and realtime room. Two apps on the same server can never see each other's data. See [Authentication](/server/auth).

## `GET /info`

Read by clients during connect, and by the realtime layer to decide whether to open a socket.

```json
{
  "name": "Our Household",
  "protocolVersion": 4,
  "minProtocolVersion": 4,
  "realtime": true,
  "mcp": true
}
```

`name` comes from `SERVER_NAME`; `realtime` reflects `ENABLE_REALTIME === "true"`; `protocolVersion` / `minProtocolVersion` are the range of client protocols this build serves. Any extra fields (like `mcp`) come from the `info` option passed to `createSyncApp`. The reserved keys `name`, `protocolVersion`, `minProtocolVersion`, and `realtime` can't be overridden.

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

## `POST /apps`

Dynamic app provisioning, guarded by the `PROVISION_KEY` master secret (the route returns `404` when the secret isn't set). Creates the app on first call (`201`, `created: true`), rotates its password on repeat calls (`200`, `created: false`). Apps defined in the `APPS` env secret return `409` — they're rotated by editing the secret. Table-stored passwords are PBKDF2-hashed at rest. See [Authentication → Provisioning apps](/server/auth#provisioning-apps).

```json
{ "appName": "myapp", "password": "a-strong-password" }
```

## `GET /sync/pull`

Two modes, selected by query params:

- `?cursor=<seq>` — one page of the app's rows written after the server `seq` cursor, oldest first across every collection, with the next `cursor` and `hasMore`.
- `?collection=recipes&id=r-123` — every stored row for one document.

Each returned document carries `updatedAt`, `clientId` (whose row it is) and `seq`. A response may hold several rows with the same `id` — siblings from different clients — which the client folds; see [Sync](/guide/sync#clients-resolve-conflicts-the-server-stores-siblings).

## `POST /sync/push`

Writes a batch of documents into the **calling client's own rows** (`(app_name, collection, id, client_id)`). The server never compares one client's row with another's; the only check is that a client's *own* row doesn't move backwards — a document whose `updatedAt` is older than what that client already stored is declined (not counted in `accepted`), which is the correct outcome for an out-of-order push.

```json
{ "documents": [{ "id": "r-1", "collection": "recipes", "updatedAt": "…", "data": { … } }] }
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
