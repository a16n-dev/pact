# Programmatic API

Every HTTP route's logic is also exported as a named function, so code composed into the sync Worker (a custom route in your deploy package, an operator script) can call it directly — no HTTP loopback, one source of truth with the sync surface.

Every data function takes an **`AppContext`** (`{ appName }`) right after `env` — the server is [multi-tenant](/server/auth), and app scoping is a required argument rather than a convention, so no in-Worker caller can accidentally read or write across apps. HTTP handlers build it from the authenticated client row; your in-Worker code passes the app it's acting for.

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
| `wipeAllDocumentsViaApi` | Delete every document **of one app**. |
| `wipeAllBlobsViaApi` | Delete every blob (registry + bytes) **of one app**. |

Both require an `AppContext` — there is no all-tenants wipe, so an operator can't erase every app in one call.

## Example: in-Worker without loopback

A custom route or operator script in the sync Worker that needs the authoritative blob set doesn't make an HTTP call to its own Worker — it calls the function:

```ts
import { listBlobs, getBlob } from '@a16n/pact-server';

const app = { appName: 'myapp' };
const hashes = await listBlobs(env, app); // same logic as GET /sync/blobs
const bytes = await getBlob(env, app, hashes[0]); // same logic as GET /sync/blobs/:hash
```

For anything domain-shaped (an agent's tools, a companion service), prefer connecting as a normal sync client with `@a16n/pact-client` instead — you get the full collection API, validation, and migration behavior, plus tenant isolation. See [Agents & MCP](/server/mcp).

::: tip Why expose both
The HTTP routes are thin shells over these functions. Keeping the logic in plain functions means the same behavior is reachable two ways: over the network for clients, and in-process for agents — with no duplicated implementation and no chance of the two drifting apart.
:::
