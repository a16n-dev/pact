## Pact

Pact is an intentionally simple client/server architecture for building local-first apps designed to be used by a small group of individuals and agents collaborating in real-time in a high trust environment.

## Features

- [x] **Offline first** — clients function fully offline; sync is optional and additive
- [x] **Realtime** — clients are notified of changes as they land on the server, enabling real-time collaboration
- [x] **Agents as first-class users** — build MCP tools directly into the server so agents read and write the same data clients do, in real time
- [x] **JSON document + blob storage** — store and sync structured documents alongside images and other files

## Design assumptions

Pact deliberately trades generality for simplicity. It assumes:

- **A small, high-trust group.** One server per group (e.g. a household). Authentication is a single shared server password that's traded for per-client tokens — there's no per-document access control. Everyone who can connect can read and write everything.
- **Last-write-wins is good enough.** Conflicts resolve by comparing `updatedAt` timestamps. There are no CRDTs, vector clocks, or merge UIs. For a small group editing mostly-disjoint data this is rarely felt; for high-contention concurrent edits to the same field it isn't the right tool.
- **Schemas are owned by the consumer.** Pact stores documents as opaque `BaseDocument`-shaped bags. Validation (typically Zod), migrations, and the list of collections are injected by the consuming domain package. Pact never inspects your document bodies except to read the base fields.

## The two packages

| Package | Runs where | Purpose |
|---------|-----------|---------|
| `@a16n/pact-client` | App / CLI / in-Worker | The `Store` — local CRUD, optimistic writes, sync, realtime, migrations. Pluggable storage via adapters. |
| `@a16n/pact-server` | Cloudflare Workers | The sync HTTP layer as a composable Hono app, backed by D1 (documents) and R2 (blobs), with a Durable Object for realtime fan-out. |

`@a16n/pact-server` depends on `@a16n/pact-client` for shared types (`BaseDocument`, `DatabaseAdapter`), so the same Store can run *inside* the Worker on top of D1 (see [`D1Adapter`](#in-worker-store-d1adapter)) — letting agent/tool code and client code share repositories built on one Store API.

## The document model

Every document extends a `BaseDocument`. The consumer adds its own fields on top.

```ts
interface BaseDocument {
  id: string;
  schemaVersion: number;       // per-collection shape version; migrators upgrade old docs on read
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601 — the last-write-wins clock
  createdBy: string;           // author id
  updatedBy: string;           // author id
  deletedAt: string | null;    // tombstone: null = live, ISO string = soft-deleted at this time
  deletedBy: string | null;
}
```

Key consequences of this shape:

- **Soft deletes only.** `delete` writes a tombstone (`deletedAt` set) rather than removing the row, so the deletion can sync. Reads (`get`, `list`, `getMany`) filter tombstones out; `getIncludingDeleted` returns them (seeding uses this to tell "author deleted this seed" from "never existed").
- **`updatedAt` is the conflict clock.** Both client and server resolve conflicts by keeping the higher `updatedAt`; ties go to the incoming/server copy.
- **`schemaVersion` drives migrations.** New writes are stamped with the collection's current version; older docs are walked forward on read (see [Migrations](#migrations)).

### Collections

Documents live in named collections (`recipes`, `users`, …). Collection names prefixed with `_` are reserved for Pact's internal bookkeeping and are never synced:

- `_config` — the `client` doc (clientId, clientName, sync url, token) and the `author` doc (current author id).
- `_sync_meta` — per-collection "last pulled at" timestamp, used to request only what's changed.

## The Store (client)

The `Store` is the single entry point. You construct it with a storage adapter, an optional blob adapter, and a domain config; it gives you optimistic local CRUD that transparently syncs when configured.

```ts
import { Store, InMemoryAdapter } from '@a16n/pact-client';

const store = await Store.create(
  new InMemoryAdapter(),  // or a SQLite-backed adapter
  null,                   // optional BlobAdapter
  domain,                 // StoreDomain: validate / migrator / collections / …
  { realtime: true }
);

await store.setAuthor('us-alice');

const recipes = store.collection('recipes');
await recipes.create('r-123', { title: 'Soup', servings: 4 });
const live = await recipes.list();
```

`Store.create` restores persisted sync credentials from `_config/client` and the current author from `_config/author`, so a returning client reconnects and keeps its identity automatically.

### Optimistic writes

Mutations (`create`, `update`, `delete`, and their `*Many` variants) follow the same path:

1. Validate + stamp `schemaVersion` (via the domain `validate` hook).
2. Write to the local adapter.
3. Emit a `change` event so the UI can re-read.
4. Fire-and-forget push to the server (failures are swallowed — the write is already durable locally and will be re-sent by `pushAll`).

This means writes never block on the network and always succeed offline.

### `StoreDomain` — the consumer's injection point

```ts
interface StoreDomain {
  validate?: (collection: string, doc: unknown) => unknown;  // throw to reject; typically a Zod parse
  migrator?: Migrator;                                        // defaults to a no-op
  collections?: readonly string[];                            // collections iterated by pushAll / pull-all
  isSeedDoc?: (doc: BaseDocument) => boolean;                 // which docs pushAll skips (see Seeds)
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;  // materialize the author as a doc
}
```

All fields are optional; omit one and the Store skips that step.

### Collection handle

`store.collection<T>(name)` returns a thin typed wrapper so you don't repeat the collection name:

```ts
const recipes = store.collection<Recipe>('recipes');
await recipes.get(id);
await recipes.getMany(ids);
await recipes.list();
await recipes.create(id, input);
await recipes.update(id, partial);
await recipes.delete(id);
await recipes.createMany(items);
await recipes.updateMany(updates);
await recipes.deleteMany(ids);
await recipes.pull();              // pull this collection's changes from the server
await recipes.pullDocument(id);    // pull a single doc by id
```

## Authors & identity

An **author id** records who created/updated a document. Two ids are reserved:

- `_system` — seed/system-generated content. Written via `createAsSystem`. By default these are treated as seed docs and excluded from sync (every client reseeds the same content locally).
- `_local` — placeholder for writes made before the client has claimed a real identity on a server. **The server rejects any push containing a `_local` author** — you must claim an identity and reassign first.

Identity flow:

```ts
await store.setAuthor('us-alice');           // records current author in _config/author
await store.reassignLocalAuthor('us-alice'); // rewrites _local docs to a real id so they can sync
```

`onSetAuthor` lets a domain that models authors *as documents* (e.g. a `users/` collection) materialize that entity the first time an identity is set.

## Sync

Sync is HTTP, pull-based for reads and push-based for writes, with last-write-wins reconciliation throughout.

| Operation | What it does |
|-----------|--------------|
| optimistic push | every mutation fire-and-forgets the changed docs to `POST /sync/push` |
| `store.pushAll()` | re-sends everything (minus untouched seeds and `_` collections) — the offline-backlog flush |
| `store.pull(collection)` | requests docs changed since this collection's last-sync timestamp, LWW-merges them locally, advances the timestamp |
| `store.pullDocument(c, id)` | pulls a single doc (LWW against the local copy) |

**Last-write-wins, both directions.** On pull, an incoming doc older than the local copy is skipped (so a not-yet-pushed local edit isn't clobbered by a stale server version). The server's upsert mirrors this: `ON CONFLICT … WHERE excluded.updated_at >= documents.updated_at`. Ties go to the incoming doc.

## Realtime

When `realtime: true` and the server has the feature enabled, the client opens a WebSocket to `/realtime`. The server doesn't push document *bodies* — it pushes lightweight **invalidations**:

```
{ "type": "invalidate", "collections": ["recipes", "groceryItems"] }
```

On receiving one, the client pulls the named collections. On (re)connect it pulls all registered collections to backfill anything missed while offline. The connection:

- Probes `GET /info` first and silently no-ops if the server hasn't enabled realtime.
- Reconnects with exponential backoff (capped at 30s).
- Authenticates via `?token=` query param (browser WebSocket APIs can't set an `Authorization` header); native clients can use either.

Server-side, fan-out is a single Durable Object (`RealtimeDO`) using hibernatable WebSockets. Accepted writes on the push path broadcast to all connected sockets via `waitUntil`, so broadcasting never blocks the response.

## Migrations

Each collection has a migration chain. A document carries its `schemaVersion`; the `Migrator` walks it forward to the collection's current version.

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

- **Migrate-on-read.** Behind-version docs are upgraded on every read and lazily written back, so old shapes drain from local storage over time.
- **Pure functions.** A migration's `up` can't read other collections or do IO.
- **Forward-incompat is loud.** A doc at a `schemaVersion` higher than the build knows throws ("upgrade the app") rather than silently corrupting data.
- The server can run the same chain on push via the `migrate` hook, keeping client and server schemas aligned.

## Blobs

Blobs (images, files) are a content-addressed sidecar to the document store. Keys are the **SHA-256 hex digest of the bytes**, so identity falls out of content: writes are idempotent, dedupe is automatic, and "same blob?" is a string comparison.

The `BlobAdapter` is optional (`null` for JSON-only consumers like CLIs):

```ts
interface BlobAdapter {
  has(hash: string): Promise<boolean>;
  read(hash: string): Promise<Uint8Array | null>;
  write(hash: string, bytes: Uint8Array): Promise<void>;
  delete(hash: string): Promise<void>;
  list(): Promise<string[]>;
  uriFor(hash: string): string | null;  // renderable URI (e.g. file://) when present locally
}
```

On the server, bytes live in R2 keyed by hash, with a `blobs` registry table recording existence + metadata (mime/size/createdAt) queryable without fetching bytes. Clients `GET /sync/blobs` to get the authoritative hash set and diff it against their local cache.

## Seeds

A deployment can ship reference data (units, a recipe catalog, …) that every client seeds locally and identically. Syncing it would just duplicate bytes, so `pushAll` filters out untouched seed docs. The default seed marker is `createdBy === updatedBy === '_system'`; override via `isSeedDoc`. The moment a real author edits a seeded doc it stops matching and syncs normally.

On the server side, seed-only collections that never reach D1 can still be read in-Worker via a [`SeedOverlay`](#in-worker-store-d1adapter).

---

## Server

### Composing the app

`@a16n/pact-server` ships the sync surface as a Hono app you mount or export directly. All behaviour is also exposed as named functions, so the HTTP routes are thin shells.

```ts
import { createSyncApp, RealtimeDO } from '@a16n/pact-server';

export { RealtimeDO };  // Durable Object class for realtime fan-out

export default createSyncApp({
  hooks: { migrate: (collection, data) => myMigrator.migrate(collection, data) },
  info: { mcp: true },  // extra fields merged into GET /info
});
```

### Environment bindings

```ts
interface Env {
  DB: D1Database;                              // documents + clients + blobs registry
  BLOBS: R2Bucket;                             // blob bytes
  API_KEY: string;                             // shared server password (wrangler secret)
  SERVER_NAME: string;                         // public name returned by GET /info
  ENABLE_REALTIME: string;                     // "true" to enable /realtime + broadcast
  REALTIME: DurableObjectNamespace<RealtimeDO>;
}
```

### HTTP API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/status` | none | liveness — `{ status: "ok" }` |
| GET | `/info` | none | `{ name, protocolVersion: 1, realtime, …info }` — clients read this during connect |
| POST | `/auth/register` | Bearer **API_KEY** | trade the server password for a per-client token → `{ clientId, token }` |
| GET | `/auth/check` | Bearer **token** | validate a token → `{ ok, client }` |
| GET | `/realtime` | token (`?token=` or Bearer) | WebSocket upgrade for invalidation pushes |
| POST | `/sync/push` | Bearer **token** | upsert documents (LWW) |
| GET | `/sync/pull?collection=&since=` | Bearer **token** | docs changed since a timestamp |
| GET | `/sync/pull?collection=&id=` | Bearer **token** | a single doc by id |
| GET | `/sync/blobs` | Bearer **token** | authoritative set of stored blob hashes |
| PUT | `/sync/blobs/:hash` | Bearer **token** | upload blob bytes (hash = SHA-256 of body) |
| GET | `/sync/blobs/:hash` | Bearer **token** | download blob bytes |
| DELETE | `/admin/wipe` | Bearer **token** | wipe all documents + blobs |

**Auth model.** The server holds one shared password (`API_KEY`). A client `POST`s it once to `/auth/register` with a self-generated `clientId` and a display name, and gets back a long-lived token (`pact_<nanoid>`). Every other request carries that token as `Authorization: Bearer …`. Re-registering the same `clientId` rotates the token while keeping the client's identity. `last_seen_at` is bumped (fire-and-forget) on each authenticated request.

### D1 schema

```sql
CREATE TABLE documents (
  id TEXT NOT NULL, collection TEXT NOT NULL,
  updated_at TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (id, collection)
);
CREATE INDEX idx_documents_pull ON documents (collection, updated_at);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_clients_token ON clients (token);
```

### Programmatic API

Every route's logic is callable directly — for in-Worker consumers that want to avoid an HTTP loopback:

`pushDocuments` · `pullDocument` · `pullDocumentsSince` · `wipeAllDocumentsViaApi` · `wipeAllBlobsViaApi` · `getBlob` · `putBlob` · `listBlobs` · `registerClient` · `lookupClientByToken` · `bumpClientLastSeen` · `extractBearerToken`.

### In-Worker Store (`D1Adapter`)

`D1Adapter` is a `DatabaseAdapter` that reads/writes the deployed Worker's D1 documents table via the programmatic API. It lets code running *inside* the Worker — notably an MCP agent's tools — build the **same** `@a16n/pact-client` `Store` other clients use, sharing one source of truth with the HTTP sync surface (no loopback fetch, no schema divergence). Tool and client code can then share repositories.

- Internal `_` collections are inert (reads empty, writes dropped) — local sync bookkeeping has no meaning when the adapter *is* the source of truth.
- A `SeedOverlay` augments D1 reads with seed-only reference collections that never get persisted server-side. Real D1 rows win on id conflicts.
- Hard delete is unsupported (the Store only ever writes tombstones via `put`).

### Optional server building blocks

- **`createLandingApp`** — a `GET /` connection page rendering a QR code that encodes a `<scheme>://<path>?url=<origin>` deep link, plus the raw origin to paste manually. Mount it where you want (typically `/`).
- **`createOAuthAuthApp`** — an OAuth authorize surface (`GET`/`POST /authorize`) for connecting agents. It renders a "connect this agent" password form, validates against `API_KEY`, registers a sync-client row, and completes the OAuth grant. `buildIdentity` lets the deploy package own its id conventions and the props its agent later sees. Used with `@cloudflare/workers-oauth-provider`.
- **`RealtimeDO`** — the Durable Object backing `/realtime`. Export it from your Worker entry and declare it in `wrangler.toml`.

### Deploy notes

A typical `wrangler.toml` binds D1 (`DB`), R2 (`BLOBS`), the `RealtimeDO` durable object, and — if running an MCP agent — an OAuth KV namespace. `SERVER_NAME` and `ENABLE_REALTIME` are plain vars; `API_KEY` is a secret (`wrangler secret put API_KEY`). When realtime is gated off, the Durable Object stays deployed but idle, so it costs nothing.
