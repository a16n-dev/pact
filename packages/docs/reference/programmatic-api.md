# Programmatic API

Every HTTP route's logic is also exported as a named function, so in-Worker consumers can call it directly — no HTTP loopback. This is what lets [in-Worker agents](/server/mcp) and the [`D1Adapter`](/server/mcp#in-worker-store-d1adapter) share one source of truth with the sync surface.

## Sync

| Function | Mirrors | Purpose |
|----------|---------|---------|
| `pushDocuments` | `POST /sync/push` | Upsert a batch of documents (last-write-wins). |
| `pullDocument` | `GET /sync/pull?…&id=` | Fetch a single document by id. |
| `pullDocumentsSince` | `GET /sync/pull?…&since=` | Fetch documents in a collection changed since a timestamp. |

## Blobs

| Function | Mirrors | Purpose |
|----------|---------|---------|
| `listBlobs` | `GET /sync/blobs` | The authoritative set of stored blob hashes. |
| `getBlob` | `GET /sync/blobs/:hash` | Fetch bytes for a hash. |
| `putBlob` | `PUT /sync/blobs/:hash` | Store bytes under their content hash. |

## Auth

| Function | Mirrors | Purpose |
|----------|---------|---------|
| `registerClient` | `POST /auth/register` | Create / rotate a client row, returning its token. |
| `lookupClientByToken` | (middleware) | Resolve a bearer token to a client row, or `null`. |
| `bumpClientLastSeen` | (middleware) | Update a client's `last_seen_at` (fire-and-forget). |
| `extractBearerToken` | — | Parse a bearer token out of an `Authorization` header. |
| `timingSafeEqual` | — | Constant-time string comparison for password / token checks. |

## Admin (operator-only)

These power destructive operations that are **deliberately not exposed over HTTP** — there's no route that can erase the group's data with a single client credential. Use them from trusted server-side / operator contexts only.

| Function | Purpose |
|----------|---------|
| `wipeAllDocumentsViaApi` | Delete every document. |
| `wipeAllBlobsViaApi` | Delete every blob (registry + bytes). |

## Example: in-Worker without loopback

An MCP tool that needs the authoritative blob set doesn't make an HTTP call to its own Worker — it calls the function:

```ts
import { listBlobs, getBlob } from '@pact/server';

const hashes = await listBlobs(env); // same logic as GET /sync/blobs
const bytes = await getBlob(env, hashes[0]); // same logic as GET /sync/blobs/:hash
```

For document reads and writes, prefer building a [`Store` on the `D1Adapter`](/server/mcp#in-worker-store-d1adapter) — you get the full collection API, validation, and migration behavior instead of raw upserts.

::: tip Why expose both
The HTTP routes are thin shells over these functions. Keeping the logic in plain functions means the same behavior is reachable two ways: over the network for clients, and in-process for agents — with no duplicated implementation and no chance of the two drifting apart.
:::
