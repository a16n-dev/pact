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

`createSyncApp` returns a Hono app. You can `export default` it directly, or mount it inside a larger router alongside your own routes (e.g. a [landing page](/server/building-blocks#createlandingapp)).

## Environment bindings

The app expects this `Env`:

```ts
interface Env {
  DB: D1Database; // documents + clients + blobs registry (all app-scoped)
  BLOBS: R2Bucket; // blob bytes, keyed <appName>/<hash>
  APPS?: string; // tenant roster secret: {"appName":"password",...}
  API_KEY?: string; // deprecated single-tenant fallback password
  DEFAULT_APP_NAME?: string; // app name the API_KEY fallback serves
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
| `API_KEY` | Secret (deprecated) | Single-tenant fallback used only when `APPS` is unset — serves one app named `DEFAULT_APP_NAME` (default `"default"`). |
| `DEFAULT_APP_NAME` | Var (optional) | App name for the `API_KEY` fallback. |
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

## Migrating a single-tenant deployment

A deployment created before multi-tenancy has no `app_name` columns and bare-hash blob keys. To migrate, pick the app name your existing data belongs to (`myapp` below), then run the three steps in one maintenance window — clients tolerate brief downtime and retry sync.

**1. D1 — rebuild the tables.** SQLite can't alter primary keys, so each table is rebuilt (existing client tokens keep working):

```sql
-- documents
CREATE TABLE documents_new (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL, collection TEXT NOT NULL,
  updated_at TEXT NOT NULL, data TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (app_name, collection, id)
);
INSERT INTO documents_new (app_name, id, collection, updated_at, data, seq)
  SELECT 'myapp', id, collection, updated_at, data, seq FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE UNIQUE INDEX idx_documents_app_seq ON documents (app_name, seq);
CREATE INDEX idx_documents_pull ON documents (app_name, collection, seq);

-- blobs
CREATE TABLE blobs_new (
  app_name TEXT NOT NULL,
  hash TEXT NOT NULL, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (app_name, hash)
);
INSERT INTO blobs_new (app_name, hash, mime_type, size, created_at)
  SELECT 'myapp', hash, mime_type, size, created_at FROM blobs;
DROP TABLE blobs;
ALTER TABLE blobs_new RENAME TO blobs;

-- apps (new table — nothing to migrate into it)
CREATE TABLE apps (
  app_name TEXT NOT NULL PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- clients
CREATE TABLE clients_new (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL, name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (app_name, id)
);
INSERT INTO clients_new (app_name, id, name, token, created_at, last_seen_at)
  SELECT 'myapp', id, name, token, created_at, last_seen_at FROM clients;
DROP TABLE clients;
ALTER TABLE clients_new RENAME TO clients;
CREATE INDEX idx_clients_token ON clients (token);
```

**2. R2 — prefix the blob keys.** Every existing object belongs to the one legacy app, so copy each bare-hash key to `myapp/<hash>` and delete the original (a small operator script over `list` → `get` → `put` → `delete`; there is deliberately **no** runtime fallback to bare-hash keys — that would let another app read legacy blobs).

**3. Secrets.** `wrangler secret put APPS` with `{"myapp":"<the old API_KEY value>"}` (add more apps whenever), deploy the new server version, then delete the old `API_KEY` secret. Existing clients keep their tokens and keep working; only *new* registrations need the `appName`.

