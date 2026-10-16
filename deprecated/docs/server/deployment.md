# Deployment (Cloudflare)

`@a16n/pact-server` runs as a Cloudflare Worker backed by:

- **D1** — documents, the clients table, and the blob registry.
- **R2** — blob bytes.
- **A Durable Object** (`RealtimeDO`) — realtime fan-out over WebSockets.

The server is generic and [multi-tenant](/server/auth): no app-specific code goes into a deployment, and new apps are provisioned by editing the `APPS` secret. So the normal way to deploy is **copy the template — you shouldn't need to write any code.**

## Quick start: the template

The monorepo ships a ready-to-deploy project at [`template/`](https://github.com/a16n/pact/tree/main/template). The full walkthrough lives in its README; the shape of it:

```bash
# 1. Copy the template and drop in the packed server tarball
cp -r pact/template my-sync-server && cd my-sync-server
cp ../pact/artifacts/a16n-pact-server-<version>.tgz vendor/a16n-pact-server.tgz

# 2. Install + authenticate
pnpm install
pnpm exec wrangler login

# 3. Provision (paste the printed database_id into wrangler.jsonc)
pnpm exec wrangler d1 create pact-db
pnpm exec wrangler r2 bucket create pact-blobs
pnpm run schema        # applies node_modules/@a16n/pact-server/schema.sql

# 4. Deploy, then enable app provisioning
pnpm run deploy
pnpm exec wrangler secret put PROVISION_KEY   # one master key

# 5. Create apps whenever you need them — no redeploy
curl -X POST https://<url>/apps \
  -H "Authorization: Bearer <PROVISION_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"appName":"myapp","password":"a-strong-password"}'
```

(Prefer a fixed roster? Skip `PROVISION_KEY` and set the `APPS` secret instead — `{"myapp":"pw", ...}`. Both modes are covered in [Authentication](/server/auth#provisioning-apps).)

Verify with `curl <url>/status`, then clients [register](/server/auth) with the URL, their `appName`, and that app's password. Day-2 operations (adding a tenant, upgrading the vendored tarball, local dev via `.dev.vars`) are covered in the template README.

Everything below documents what the template contains — read on if you're composing a custom Worker instead.

## Compose the app yourself

The minimal Worker entry exports the sync app and re-exports the Durable Object class:

```ts
// src/worker.ts
import { createSyncApp, RealtimeDO } from '@a16n/pact-server';

export { RealtimeDO }; // Durable Object class for realtime fan-out

export default createSyncApp({
  // run your migration chain server-side on the push path (optional)
  hooks: { migrate: (collection, data) => myMigrator.migrate(collection, data) },
  // extra fields merged into GET /info — advertise capabilities you've wired up
  info: { mcp: true },
});
```

`createSyncApp` returns a Hono app. You can `export default` it directly, or mount it inside a larger router alongside your own routes.

## Environment bindings

The app expects this `Env`:

```ts
interface Env {
  DB: D1Database; // documents + clients + blobs registry (all app-scoped)
  BLOBS: R2Bucket; // blob bytes, keyed <appName>/<hash>
  APPS?: string; // tenant roster secret: {"appName":"password",...}
  SERVER_NAME: string; // public name returned by GET /info
  ENABLE_REALTIME: string; // "true" to enable /realtime + broadcast
  REALTIME: DurableObjectNamespace<RealtimeDO>;
}
```

| Binding | Kind | Notes |
|---------|------|-------|
| `DB` | D1 database | Holds `documents`, `clients`, `blobs` — every row scoped by `app_name`. |
| `BLOBS` | R2 bucket | Raw blob bytes, keyed `<appName>/<sha-256>`. |
| `REALTIME` | Durable Object namespace | Bound to the `RealtimeDO` class; one DO instance per app. |
| `APPS` | Secret (optional) | Static tenant roster: a JSON object of `{ "appName": "password" }`. Set with `wrangler secret put APPS`. |
| `PROVISION_KEY` | Secret (optional) | Enables dynamic provisioning: `POST /apps` creates an app (or rotates its password) at runtime — no secret edits, no redeploy. Set at least one of `APPS` / `PROVISION_KEY`. |
| `SERVER_NAME` | Var | Human-readable name returned by `GET /info`. |
| `ENABLE_REALTIME` | Var | `"true"` enables `/realtime` + broadcast; anything else disables it. |

The server is **multi-tenant**: clients of completely different apps register with their own `appName` + password and can never see each other's documents, blobs, or realtime broadcasts. See [Authentication](/server/auth) for the model.

## `wrangler.toml`

A representative config binding everything:

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
```

::: tip Durable Object migration block
Cloudflare requires a `[[migrations]]` entry the first time you introduce a Durable Object class. `RealtimeDO` uses SQLite-backed storage, so it goes under `new_sqlite_classes`. This is a *Cloudflare platform* migration, unrelated to Pact's [document migrations](/guide/migrations).
:::

## Provision and deploy

```bash
# 1. Create the D1 database and apply the schema
wrangler d1 create household
# the canonical DDL ships inside the package:
wrangler d1 execute household --remote --file node_modules/@a16n/pact-server/schema.sql

# 2. Create the R2 bucket
wrangler r2 bucket create household-blobs

# 3. Set the tenant roster (JSON: { "appName": "password", ... })
wrangler secret put APPS
# paste e.g. {"myapp":"a-strong-password"}

# 4. Deploy
wrangler deploy
```

The canonical DDL ships as `schema.sql` inside the `@a16n/pact-server` package; the [D1 Schema reference](/reference/schema) documents every table and index.

## Verify

```bash
curl https://my-household-sync.<subdomain>.workers.dev/status
# → { "status": "ok" }

curl https://my-household-sync.<subdomain>.workers.dev/info
# → { "name": "Our Household", "protocolVersion": 3, "realtime": true, "mcp": true }
```

A client then [registers](/server/auth) with the server URL, its `appName`, and that app's password from the roster you set in step 3.

## Realtime costs nothing when off

When realtime is gated off (`ENABLE_REALTIME` ≠ `"true"`), the `/realtime` route returns `404` and the Durable Object stays deployed but **idle** — it costs nothing until a socket connects and a write fans out. You can flip realtime on later by changing the var and redeploying; no schema or binding changes needed.

