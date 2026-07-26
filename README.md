## Pact

Pact is an intentionally simple client/server architecture for building local-first apps designed to be used by a small group of individuals and agents collaborating in real-time in a high trust environment.

## Features

- [x] **Offline first** — clients function fully offline; sync is optional and additive
- [x] **Realtime** — clients are notified of changes as they land on the server, enabling real-time collaboration
- [x] **Agents as first-class users** — an agent (e.g. an MCP server built on `@a16n/pact-client`) registers as an ordinary sync client and reads and writes the same data other clients do, in real time
- [x] **JSON document + blob storage** — store and sync structured documents alongside images and other files
- [x] **Optional end-to-end encryption** — domain fields sealed into one ciphertext string, at rest locally and on the server; only base sync fields stay cleartext

## Design assumptions

Pact deliberately trades generality for simplicity. It assumes:

- **A small, high-trust group.** One server per group (e.g. a household). Authentication is a single shared server password that's traded for per-client tokens — there's no per-document access control. Everyone who can connect can read and write everything.
- **Last-write-wins is good enough.** Conflicts resolve by comparing `updatedAt` timestamps. There are no CRDTs, vector clocks, or merge UIs. For a small group editing mostly-disjoint data this is rarely felt; for high-contention concurrent edits to the same field it isn't the right tool.
- **Schemas are required, and owned by the consumer.** Every collection is declared with a Zod schema (plus id prefix and migrations) via `defineCollection`, and the set of definitions handed to the Store *is* the set of collections that exist — undefined collections are rejected. Beyond validating writes against your schemas, Pact never inspects document bodies except to read the base fields.

## The two packages

| Package | Runs where | Purpose |
|---------|-----------|---------|
| `@a16n/pact-client` | App / CLI / in-Worker | The `Store` — local CRUD, optimistic writes, sync, realtime, migrations. Pluggable storage via adapters. |
| `@a16n/pact-server` | Cloudflare Workers | The sync HTTP layer as a composable Hono app, backed by D1 (documents) and R2 (blobs), with a Durable Object for realtime fan-out. |

The two packages are independent — the server has no dependency on the client. Anything that wants to act on the data (an app, a CLI, an agent's MCP server) builds on `@a16n/pact-client` and connects as a sync client.

## Building & consuming

The packages aren't published to a registry; they're consumed as tarballs.

```sh
pnpm build     # tsup-bundles each package to dist/ (ESM + .d.ts + sourcemaps)
pnpm pack:all  # packs both packages into artifacts/*.tgz (runs the build via prepack)
```

Inside this workspace, package `exports` point at raw TypeScript source (`src/index.ts`) so dev, tests, and typechecking need no build step. At pack time, `publishConfig` redirects `exports`/`types` to `dist/`, and pnpm rewrites `catalog:` versions to concrete ones — so the tarballs are self-contained and installable anywhere. The two packages are independent: apps vendor the client tarball, server deployments vendor the server tarball.

(`@a16n/pact-server` imports `cloudflare:workers`, so it only runs under wrangler/workerd — plain Node can typecheck against it but not import it.)

### Deploying a server

You don't extend the server — you deploy it. Copy the ready-made project in [`template/`](template/), drop the packed `@a16n/pact-server` tarball into its `vendor/`, and follow its README: `wrangler d1 create` + `r2 bucket create`, apply the packaged `schema.sql`, `wrangler deploy`, then set a `PROVISION_KEY` secret. Adding an app is then one `POST /apps` call — no secret edits, no redeploy (a static `APPS` roster secret remains as an alternative).

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

## Examples

[`examples/`](./examples) holds working, tested reference material:

- [`examples/todo-cli`](./examples/todo-cli) — a complete client app (Node CLI TODO list): domain definition, storage adapter, typed CRUD, optional sync.
- [`examples/adapters`](./examples/adapters) — copy-paste `DatabaseAdapter` recipes (localStorage, IndexedDB, JSON file, `node:sqlite`, `expo-sqlite`) plus a reusable adapter contract test.

## The Store (client)

The `Store` is the single entry point. You construct it with a storage adapter, an optional blob adapter, and a domain config; it gives you optimistic local CRUD that transparently syncs when configured.

```ts
import { Store, InMemoryAdapter } from '@a16n/pact-client';

const store = await Store.create(
  new InMemoryAdapter(),  // or a SQLite-backed adapter
  null,                   // optional BlobAdapter
  domain,                 // StoreDomain: your collection definitions + hooks
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

1. Validate + stamp `schemaVersion` (a parse against the collection's schema).
2. Write to the local adapter.
3. Emit a `change` event so the UI can re-read.
4. Fire-and-forget push to the server (failures are swallowed — the write is already durable locally and will be re-sent by `pushAll`).

This means writes never block on the network and always succeed offline.

### `StoreDomain` — the consumer's injection point

```ts
interface StoreDomain {
  collections: readonly CollectionDefinition[];  // required — the schemas ARE the collections
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;  // materialize the author as a doc
  blobHashes?: (collection: string, doc: BaseDocument) => Iterable<string>;  // blob refs for GC / pull
  encryption?: { cipher: DocCipher };            // optional E2E encryption
}
```

Each entry comes from `defineCollection({ name, idPrefix, schema, migrations?, synced? })`. The Store derives write validation, the migrator, id parsing, and the sync enumeration from this list, and rejects reads and writes against any collection not in it.

### Collection handle

`store.collection(name)` returns a thin typed wrapper so you don't repeat the collection name — the name is narrowed to your defined collections and the document type is inferred from that collection's schema:

```ts
const recipes = store.collection('recipes');
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

Seed-only collections never reach the server at all — every consumer that needs them (apps, CLIs, an agent's MCP Worker) seeds its own store from the same `SeedSet`.

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
  DB: D1Database;                              // documents + clients + blobs registry (all app-scoped)
  BLOBS: R2Bucket;                             // blob bytes, keyed <appName>/<hash>
  APPS?: string;                               // static tenant roster secret: {"appName":"password",...}
  PROVISION_KEY?: string;                      // master key enabling dynamic POST /apps provisioning
  SERVER_NAME: string;                         // public name returned by GET /info
  ENABLE_REALTIME: string;                     // "true" to enable /realtime + broadcast
  REALTIME: DurableObjectNamespace<RealtimeDO>;
}
```

### HTTP API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/status` | none | liveness — `{ status: "ok" }` |
| GET | `/info` | none | `{ name, protocolVersion: 3, realtime, …info }` — clients read this during connect |
| POST | `/auth/register` | Bearer **app password** | body `{ appName, clientId, clientName }` — trade the app's password for a per-client token → `{ clientId, token }` |
| POST | `/apps` | Bearer **PROVISION_KEY** | body `{ appName, password }` — create an app or rotate its password (404 when `PROVISION_KEY` unset) |
| GET | `/auth/check` | Bearer **token** | validate a token → `{ ok, client }` |
| GET | `/realtime` | token (`?token=` or Bearer) | WebSocket upgrade for invalidation pushes |
| POST | `/sync/push` | Bearer **token** | upsert documents (LWW) |
| GET | `/sync/pull?collection=&since=` | Bearer **token** | docs changed since a timestamp |
| GET | `/sync/pull?collection=&id=` | Bearer **token** | a single doc by id |
| GET | `/sync/blobs` | Bearer **token** | authoritative set of stored blob hashes |
| PUT | `/sync/blobs/:hash` | Bearer **token** | upload blob bytes (hash = SHA-256 of body) |
| GET | `/sync/blobs/:hash` | Bearer **token** | download blob bytes |

(There is deliberately no remote-wipe route; the wipe functions are exported for operator use only.)

**Auth model.** The server is **multi-tenant**: completely different apps (different schemas, different clients) share one deployment with zero data visibility between them. Apps are provisioned either statically (the `APPS` secret, a JSON roster of `{ "appName": "password" }`) or dynamically (`POST /apps` guarded by a `PROVISION_KEY` master secret; passwords stored PBKDF2-hashed in the `apps` table — the env roster wins on name collisions). A client `POST`s its app's password once to `/auth/register` with an `appName`, a self-generated `clientId` and a display name, and gets back a long-lived token (`pact_<nanoid>`) bound server-side to that app. Every other request carries just the token as `Authorization: Bearer …` — the app is resolved from the client row it was registered under, never from anything the client sends later. Re-registering the same `clientId` rotates the token while keeping the client's identity. `last_seen_at` is bumped (fire-and-forget) on each authenticated request.

**Tenant isolation.** Every D1 row carries an `app_name` (baked into every query and primary key, with a per-app `seq` counter), blob bytes are keyed `<appName>/<hash>` in R2, and each app gets its own realtime Durable Object (`idFromName(appName)`) — so documents, blobs, and broadcasts are all partitioned by construction. App names are validated (`[a-z0-9][a-z0-9_-]{0,63}`) at the only entry points that accept one.

### D1 schema

```sql
CREATE TABLE documents (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL, collection TEXT NOT NULL,
  updated_at TEXT NOT NULL, data TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (app_name, collection, id)
);
-- Unique: any per-app seq-counter bug fails loudly instead of corrupting pull cursors.
CREATE UNIQUE INDEX idx_documents_app_seq ON documents (app_name, seq);
-- The pull hot path: WHERE app_name = ? AND collection = ? AND seq > ? ORDER BY seq.
CREATE INDEX idx_documents_pull ON documents (app_name, collection, seq);

CREATE TABLE blobs (
  app_name TEXT NOT NULL,
  hash TEXT NOT NULL, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (app_name, hash)
);

CREATE TABLE clients (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL, name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,   -- globally unique: the token alone resolves the app
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (app_name, id)
);
CREATE INDEX idx_clients_token ON clients (token);
```

### Programmatic API

Every route's logic is callable directly — for in-Worker consumers that want to avoid an HTTP loopback:

`pushDocuments` · `pullDocument` · `pullDocumentsSince` · `wipeAllDocumentsViaApi` · `wipeAllBlobsViaApi` · `getBlob` · `putBlob` · `listBlobs` · `registerClient` · `lookupClientByToken` · `bumpClientLastSeen` · `extractBearerToken`.

### Agents (MCP)

The server deliberately bundles **no agent surface**. An agent's MCP server is a separate, per-app Worker built on `@a16n/pact-client`: it registers via `POST /auth/register` with its app's password like any other client, holds only that app's token (so tenant isolation applies to the agent itself), and its writes broadcast realtime invalidations for free by going through `/sync/push`.

### Optional server building blocks

- **`RealtimeDO`** — the Durable Object backing `/realtime`. Export it from your Worker entry and declare it in `wrangler.toml`.

### Deploy notes

A typical `wrangler.toml` binds D1 (`DB`), R2 (`BLOBS`), and the `RealtimeDO` durable object. `SERVER_NAME` and `ENABLE_REALTIME` are plain vars; app provisioning is secret-based — either `wrangler secret put PROVISION_KEY` (then `POST /apps` per app) or a static `wrangler secret put APPS` roster. Adding an app never touches schema or bindings. When realtime is gated off, the Durable Object stays deployed but idle, so it costs nothing.
