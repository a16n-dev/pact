# Authentication

Pact's auth model is deliberately minimal, matching its [high-trust assumption](/guide/concepts#design-assumptions): **one shared password per app, traded for long-lived per-client tokens.** The server is multi-tenant — several completely different apps can share one deployment — but *within* an app there is no per-document access control: everyone who can connect to an app can read and write all of that app's data. Across apps, nothing is visible in either direction.

## The model

```
                        ┌──────────────────────────────────────────────────┐
   the app's password   │  POST /auth/register   (Bearer: app password)    │
   (from APPS secret) ──▶│  body: { appName, clientId, clientName }         │
                        │  → { clientId, token }    token = pact_<nanoid>   │
                        └──────────────────────────────────────────────────┘
                                           │
                        every other request carries only the token:
                               Authorization: Bearer pact_<nanoid>
```

1. The server knows its apps from two sources (see [Provisioning apps](#provisioning-apps)): the static `APPS` secret and/or the dynamic `apps` table. (A legacy deployment can still use the single `API_KEY` secret; it behaves as one app named `DEFAULT_APP_NAME`, default `"default"`.)
2. A client `POST`s its app's password once to `/auth/register` with the `appName`, a self-generated `clientId` and a display name, and gets back a **long-lived token** (`pact_<nanoid>`).
3. The token is **bound to the app server-side** — the client row records which app it registered under, and every subsequent request derives its tenant from that row, never from anything the client sends. Every other request carries just the token as `Authorization: Bearer …`.
4. **Re-registering the same `clientId` rotates the token** while keeping the client's identity. The same `clientId` under a different app is a different client.
5. `last_seen_at` is bumped (fire-and-forget) on each authenticated request, so you can see which clients are active.

App names must match `[a-z0-9][a-z0-9_-]{0,63}` — they become R2 key prefixes and Durable Object names, so the charset is validated at registration. An unknown app name gets the same `401` (with a timing-uniform password comparison) as a wrong password, so app names can't be enumerated.

## Provisioning apps

Two modes, usable together (on a name collision the env secret wins — it's the operator's explicit config):

**Static — the `APPS` secret.** A JSON object of `{ "appName": "password" }` set with `wrangler secret put APPS`. Adding an app means editing the secret. Passwords live (plaintext) inside the Worker secret, never in the database.

**Dynamic — `POST /apps`.** Set a single `PROVISION_KEY` secret and the server exposes a claim endpoint (disabled entirely when the secret is unset):

```bash
curl -X POST https://<server>/apps \
  -H "Authorization: Bearer $PROVISION_KEY" \
  -H "Content-Type: application/json" \
  -d '{"appName":"myapp","password":"a-strong-password"}'
# → { "appName": "myapp", "created": true }
```

Apps land in the D1 `apps` table with the password stored **PBKDF2-hashed** (never plaintext). Re-`POST`ing the same name rotates the password (`created: false`) — already-registered clients keep working, since their tokens are independent of the password. Names defined in the `APPS` secret are rejected with `409` (edit the secret instead). Unknown-app registration burns the same hash comparison as a real app, so the endpoint's existence doesn't make app names enumerable.

## How tokens are stored

The server never stores the raw token in a way it compares directly against untrusted input without care:

- Tokens are checked against the `clients` table, indexed by token for fast lookup. The `token` column is globally `UNIQUE`, so the token alone resolves both the client and its app.
- The app password is compared using a **timing-safe equality** check (`timingSafeEqual`) to avoid leaking it a byte at a time.

The `clients` table:

```sql
CREATE TABLE clients (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL, name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (app_name, id)
);
CREATE INDEX idx_clients_token ON clients (token);
```

## Registering from a client

On the client, this is one call (see [Client Setup](/guide/client-setup#connecting-to-a-server)):

```ts
await store.registerClient(
  'https://my-sync-server.workers.dev',
  appPassword, // this app's entry in the APPS roster
  'myapp', // which app on the server this client belongs to
  "Alice's laptop" // display name
);
```

The returned `{ clientId, token }` is persisted in `_config/client`, so the client reconnects automatically on future launches.

## Which routes need what

| Auth | Routes |
|------|--------|
| **None** | `GET /status`, `GET /info` |
| **Bearer app password** (+ `appName` in body) | `POST /auth/register` |
| **Bearer token** (per-client, app-bound) | `GET /auth/check`, all `/sync/*`, `GET /realtime` |

`/realtime` additionally accepts the token via a `?token=` query param, because browser WebSocket APIs can't set an `Authorization` header. See the full [HTTP API reference](/reference/http-api).

## End-to-end encryption is orthogonal

Clients may additionally enable [E2E document encryption](/guide/encryption). The server needs no configuration for it — document bodies are already opaque to it, encrypted or not. Auth (this page) controls *who can connect*; encryption controls *what a connected server can read*.

## No remote wipe

There is **no HTTP route to wipe the database** — it would let any single client credential erase the whole group's data. The wipe functions (`wipeAllDocumentsViaApi`, `wipeAllBlobsViaApi`) remain exported for trusted server-side / operator use only, and they wipe **one app at a time** — both require an `AppContext`, so an operator can't accidentally erase every tenant. See [Programmatic API](/reference/programmatic-api).

## Agents authenticate too

An MCP agent connects through the same flow: its (separate, per-app) MCP Worker registers via `POST /auth/register` with the app's password — typically once per connecting agent, from inside that Worker's own OAuth authorize flow — and ends up as a normal `clients` row under that app. From the data's perspective an agent is just another client. See [Agents & MCP](/server/mcp).
