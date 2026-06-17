# Authentication

Pact's auth model is deliberately minimal, matching its [high-trust assumption](/guide/concepts#design-assumptions): **one shared server password, traded for long-lived per-client tokens.** There is no per-document access control — everyone who can connect can read and write everything.

## The model

```
                       ┌──────────────────────────────────────────────┐
   server password     │  POST /auth/register   (Bearer: API_KEY)     │
   (API_KEY secret) ───▶│  body: { clientId, clientName }              │
                       │  → { clientId, token }   token = pact_<nanoid>│
                       └──────────────────────────────────────────────┘
                                          │
                       every other request carries the token:
                              Authorization: Bearer pact_<nanoid>
```

1. The server holds **one** shared password, the `API_KEY` secret.
2. A client `POST`s it once to `/auth/register` with a self-generated `clientId` and a display name, and gets back a **long-lived token** (`pact_<nanoid>`).
3. Every other request carries that token as `Authorization: Bearer …`.
4. **Re-registering the same `clientId` rotates the token** while keeping the client's identity.
5. `last_seen_at` is bumped (fire-and-forget) on each authenticated request, so you can see which clients are active.

## How tokens are stored

The server never stores the raw token in a way it compares directly against untrusted input without care:

- Tokens are checked against the `clients` table, indexed by token for fast lookup.
- The shared password is compared using a **timing-safe equality** check (`timingSafeEqual`) to avoid leaking it a byte at a time.

The `clients` table:

```sql
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_clients_token ON clients (token);
```

## Registering from a client

On the client, this is one call (see [Client Setup](/guide/client-setup#connecting-to-a-server)):

```ts
await store.registerClient(
  'https://my-household-sync.workers.dev',
  serverPassword, // the API_KEY value
  "Alice's laptop" // display name
);
```

The returned `{ clientId, token }` is persisted in `_config/client`, so the client reconnects automatically on future launches.

## Which routes need what

| Auth | Routes |
|------|--------|
| **None** | `GET /status`, `GET /info` |
| **Bearer `API_KEY`** (the password) | `POST /auth/register` |
| **Bearer token** (per-client) | `GET /auth/check`, all `/sync/*`, `GET /realtime` |

`/realtime` additionally accepts the token via a `?token=` query param, because browser WebSocket APIs can't set an `Authorization` header. See the full [HTTP API reference](/reference/http-api).

## No remote wipe

There is **no HTTP route to wipe the database** — it would let any single client credential erase the whole group's data. The wipe functions (`wipeAllDocumentsViaApi`, `wipeAllBlobsViaApi`) remain exported for trusted server-side / operator use only. See [Programmatic API](/reference/programmatic-api).

## Agents authenticate too

An MCP agent connects through the same password, but via an OAuth authorize flow rather than a raw `POST`. The flow renders a "connect this agent" form, validates the password against `API_KEY`, and registers a normal `clients` row — so from the data's perspective an agent is just another client. See [Agents & MCP](/server/mcp).
