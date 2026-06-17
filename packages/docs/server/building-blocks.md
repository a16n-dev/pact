# Building Blocks

Beyond `createSyncApp`, `@pact/server` exports a few optional pieces you compose into your Worker as needed. Each is independent — mount what you want, ignore the rest.

## `createLandingApp`

A `GET /` **connection page** that renders a QR code encoding a deep link, plus the raw origin to paste manually. Point a phone at it and the client app opens pre-filled with the server URL.

```ts
import { Hono } from 'hono';
import { createSyncApp, createLandingApp, RealtimeDO } from '@pact/server';

export { RealtimeDO };

const app = new Hono();
app.route('/', createLandingApp({ /* LandingOptions */ }));
app.route('/', createSyncApp({ /* ... */ }));

export default app;
```

The QR code encodes a `<scheme>://<path>?url=<origin>` deep link — your app registers the scheme, and the `url` param tells it which server to connect to. Mount it wherever you like (typically `/`).

## `createOAuthAuthApp`

The OAuth authorize surface for connecting **agents** — a `GET`/`POST /authorize` pair that validates the server password and registers the agent as a sync client. Covered in full on [Agents & MCP](/server/mcp#authenticating-an-agent-createoauthauthapp).

## `RealtimeDO`

The **Durable Object** backing `/realtime`. Export it from your Worker entry and declare it in `wrangler.toml`:

```ts
export { RealtimeDO } from '@pact/server';
```

```toml
[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RealtimeDO"]
```

It uses hibernatable WebSockets, so idle connections evict from memory and cost nothing. Accepted writes broadcast to all connected sockets via `waitUntil`, never blocking the push response. See [Realtime](/guide/realtime) for the protocol and [Deployment](/server/deployment) for the full config.

## `D1Adapter`

A `DatabaseAdapter` that lets code **inside** the Worker build the same `@pact/client` `Store` clients use, backed by the deployed D1 documents table. This is the foundation for in-Worker agents and MCP tools — see [Agents & MCP](/server/mcp#in-worker-store-d1adapter).

## How they compose

A fully-loaded Worker entry — sync surface, landing page, realtime, and an agent OAuth flow — is just a handful of `route` calls over one Hono app:

```ts
import { Hono } from 'hono';
import {
  createSyncApp,
  createLandingApp,
  createOAuthAuthApp,
  RealtimeDO,
} from '@pact/server';

export { RealtimeDO };

const app = new Hono();
app.route('/', createLandingApp({ /* ... */ }));   // GET / → QR connect page
app.route('/', createOAuthAuthApp({ /* ... */ }));  // /authorize → agent OAuth
app.route('/', createSyncApp({ info: { mcp: true } })); // /sync/*, /auth/*, /realtime, ...

export default app;
```

Because every building block is a Hono app (or a Durable Object class), you stay in plain Hono composition the whole way — there's no Pact-specific wiring to learn beyond "mount the apps you want."
