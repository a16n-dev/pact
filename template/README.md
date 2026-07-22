# Pact sync server

A ready-to-deploy [Pact](https://github.com/a16n/pact) sync server for Cloudflare Workers: multi-tenant document sync backed by D1 (documents), R2 (blobs), and a Durable Object (realtime). There is no app-specific code in here — apps are provisioned by editing a secret, and clients of completely different apps share this one deployment with zero data visibility between them.

## Deploy

**1. Copy this template and vendor the server package.**

```bash
cp -r template my-sync-server && cd my-sync-server
cp path/to/pact/artifacts/a16n-pact-server-<version>.tgz vendor/a16n-pact-server.tgz
```

**2. Install.**

```bash
pnpm install
```

**3. Log in to Cloudflare.**

```bash
pnpm exec wrangler login
```

**4. Create the database and bucket.**

```bash
pnpm exec wrangler d1 create pact-db
# → paste the printed database_id into wrangler.jsonc (replacing <REPLACE_ME>)

pnpm exec wrangler r2 bucket create pact-blobs
```

(Pick different names if you like — update `wrangler.jsonc` and the `schema` script to match.)

**5. Apply the schema.**

```bash
pnpm run schema
```

**6. Deploy.**

```bash
pnpm run deploy
```

**7. Set the tenant roster.** A JSON object of `appName → password`; app names must match `[a-z0-9][a-z0-9_-]{0,63}`:

```bash
pnpm exec wrangler secret put APPS
# paste: {"myapp":"a-strong-password"}
```

**8. Verify.**

```bash
curl https://my-pact-server.<your-subdomain>.workers.dev/status
# → { "status": "ok" }
```

Clients connect with the server URL, their `appName`, and that app's password:

```ts
await store.registerClient(serverUrl, appPassword, 'myapp', "Alice's laptop");
```

## Day-2 operations

- **Add an app**: edit the `APPS` secret (`wrangler secret put APPS` with the new roster). No schema or config changes, no redeploy.
- **Upgrade the server**: drop the new tarball over `vendor/a16n-pact-server.tgz`, then `pnpm install && pnpm run deploy`. If the release notes include schema changes, apply them with `wrangler d1 execute` first.
- **Local dev**: `cp .dev.vars.example .dev.vars`, edit the roster, then `pnpm run dev`. Wrangler runs D1/R2/DO locally; apply the schema locally with `pnpm exec wrangler d1 execute pact-db --local --file node_modules/@a16n/pact-server/schema.sql`.
- **Rename the worker / server**: `name` and `SERVER_NAME` in `wrangler.jsonc`.
- **Migrating a pre-multi-tenant deployment**: see the Pact docs (Server → Deployment → "Migrating a single-tenant deployment").

## What's in the box

| File | Purpose |
|------|---------|
| `src/worker.ts` | The whole Worker: `createSyncApp()` + the `RealtimeDO` export. |
| `wrangler.jsonc` | Bindings: D1 (`DB`), R2 (`BLOBS`), Durable Object (`REALTIME`), plain vars. |
| `vendor/` | The `@a16n/pact-server` tarball you dropped in. |
| `.dev.vars.example` | Local-dev tenant roster template. |

The server is intentionally not extended here. If you do need custom routes (a landing page via `createLandingApp`, extra `/info` fields), `createSyncApp` returns a composable Hono app — see the Pact docs (Server → Building Blocks).
