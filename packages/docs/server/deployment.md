# Deployment (Cloudflare)

`@pact/server` ships the sync surface as a **composable Hono app** you mount or export directly. It's designed to run as a Cloudflare Worker backed by:

- **D1** — documents, the clients table, and the blob registry.
- **R2** — blob bytes.
- **A Durable Object** (`RealtimeDO`) — realtime fan-out over WebSockets.

All behaviour is also exposed as named functions, so the HTTP routes are thin shells — see the [Programmatic API](/reference/programmatic-api).

## Compose the app

The minimal Worker entry exports the sync app and re-exports the Durable Object class:

```ts
// src/worker.ts
import { createSyncApp, RealtimeDO } from '@pact/server';

export { RealtimeDO }; // Durable Object class for realtime fan-out

export default createSyncApp({
  // run your migration chain server-side on the push path (optional)
  hooks: { migrate: (collection, data) => myMigrator.migrate(collection, data) },
  // extra fields merged into GET /info — advertise capabilities you've wired up
  info: { mcp: true },
});
```

`createSyncApp` returns a Hono app. You can `export default` it directly, or mount it inside a larger router alongside your own routes (a [landing page](/server/building-blocks#createlandingapp), an [OAuth surface](/server/mcp), etc).

## Environment bindings

The app expects this `Env`:

```ts
interface Env {
  DB: D1Database; // documents + clients + blobs registry
  BLOBS: R2Bucket; // blob bytes
  API_KEY: string; // shared server password (wrangler secret)
  SERVER_NAME: string; // public name returned by GET /info
  ENABLE_REALTIME: string; // "true" to enable /realtime + broadcast
  REALTIME: DurableObjectNamespace<RealtimeDO>;
}
```

| Binding | Kind | Notes |
|---------|------|-------|
| `DB` | D1 database | Holds `documents`, `clients`, `blobs`. |
| `BLOBS` | R2 bucket | Raw blob bytes, keyed by SHA-256. |
| `REALTIME` | Durable Object namespace | Bound to the `RealtimeDO` class. |
| `API_KEY` | Secret | The shared server password. Set with `wrangler secret put`. |
| `SERVER_NAME` | Var | Human-readable name returned by `GET /info`. |
| `ENABLE_REALTIME` | Var | `"true"` enables `/realtime` + broadcast; anything else disables it. |

## `wrangler.toml`

A representative config binding everything (plus the OAuth KV namespace, only needed if you run an [MCP agent](/server/mcp)):

```toml
name = "my-household-sync"
main = "src/worker.ts"
compatibility_date = "2025-01-01"

# Plain vars
[vars]
SERVER_NAME = "Our Household"
ENABLE_REALTIME = "true"

# D1 — documents, clients, blob registry
[[d1_databases]]
binding = "DB"
database_name = "household"
database_id = "<your-d1-id>"

# R2 — blob bytes
[[r2_buckets]]
binding = "BLOBS"
bucket_name = "household-blobs"

# Durable Object — realtime fan-out
[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RealtimeDO"]

# Only if running an MCP agent (see Agents & MCP)
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<your-kv-id>"
```

::: tip Durable Object migration block
Cloudflare requires a `[[migrations]]` entry the first time you introduce a Durable Object class. `RealtimeDO` uses SQLite-backed storage, so it goes under `new_sqlite_classes`. This is a *Cloudflare platform* migration, unrelated to Pact's [document migrations](/guide/migrations).
:::

## Provision and deploy

```bash
# 1. Create the D1 database and apply the schema
wrangler d1 create household
wrangler d1 execute household --file=./schema.sql   # see Reference → D1 Schema

# 2. Create the R2 bucket
wrangler r2 bucket create household-blobs

# 3. Set the shared server password (this is API_KEY)
wrangler secret put API_KEY

# 4. Deploy
wrangler deploy
```

The [D1 schema](/reference/schema) — `documents`, `blobs`, `clients` and their indexes — is small enough to keep in a single `schema.sql` you apply with `wrangler d1 execute`.

## Verify

```bash
curl https://my-household-sync.<subdomain>.workers.dev/status
# → { "status": "ok" }

curl https://my-household-sync.<subdomain>.workers.dev/info
# → { "name": "Our Household", "protocolVersion": 2, "realtime": true, "mcp": true }
```

A client then [registers](/server/auth) with the server URL and the password you set in step 3.

## Realtime costs nothing when off

When realtime is gated off (`ENABLE_REALTIME` ≠ `"true"`), the `/realtime` route returns `404` and the Durable Object stays deployed but **idle** — it costs nothing until a socket connects and a write fans out. You can flip realtime on later by changing the var and redeploying; no schema or binding changes needed.
