# Agents & MCP

Pact treats **agents as first-class users**. Instead of bolting an agent onto the outside of the API, you build MCP tools *inside* the Worker, where they read and write the **same data clients do, through the same `Store`** — no HTTP loopback, no schema divergence.

Two pieces make this work: the `D1Adapter` (so agent code can build a real `Store`) and `createOAuthAuthApp` (so an agent can authenticate).

## In-Worker Store: `D1Adapter`

`D1Adapter` is a [`DatabaseAdapter`](/guide/client-setup#the-storage-adapter) that reads and writes the deployed Worker's D1 `documents` table directly, via the [programmatic API](/reference/programmatic-api). Code running *inside* the Worker — notably an MCP agent's tools — can build the **same `@a16n/pact-client` `Store`** other clients use:

```ts
import { Store } from '@a16n/pact-client';
import { D1Adapter } from '@a16n/pact-server';

// inside a Worker request / MCP tool handler, with access to env.DB
const store = await Store.create(new D1Adapter(env.DB), null, domain);

const recipes = store.collection('recipes');
await recipes.create('r-9', { title: 'Agent soup', servings: 2 });
```

That `create` writes straight to D1 — the same rows the HTTP sync surface serves. A client pulling `recipes` (or holding a realtime socket) sees the agent's write just like any other. **One source of truth, two kinds of writer.**

### What's different in-Worker

When the adapter *is* the source of truth, some client-side machinery has no meaning:

- **Internal `_` collections are inert.** Reads return empty, writes are dropped — local sync bookkeeping (`_config`, `_sync_meta`, `_outbox`) is pointless when there's nothing to sync *to*.
- **Hard delete is unsupported.** The Store only ever writes tombstones via `put`, matching the [soft-delete model](/guide/document-model#soft-deletes-only).

### Seed overlay

Some [seed-only collections](/guide/seeds) never get persisted server-side — they're client-side reference data. A **`SeedOverlay`** augments D1 reads so in-Worker code can still see them:

- Reads merge D1 rows with the seed collections.
- **Real D1 rows win on id conflicts** — a persisted edit always shadows the seed.

This lets an agent read the same unit catalog or reference list a client has, even though those rows were never synced up to D1.

## Authenticating an agent: `createOAuthAuthApp`

Agents connect over OAuth (via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)) rather than a raw `POST /auth/register`. `createOAuthAuthApp` is the **authorize surface**: a `GET`/`POST /authorize` pair that renders a "connect this agent" password form, validates the password against `API_KEY`, registers a sync-client row, and completes the OAuth grant.

```ts
import { createOAuthAuthApp } from '@a16n/pact-server';

const authApp = createOAuthAuthApp({
  branding: {
    title: (agent) => `Connect ${agent}`,
    subtitle: 'Enter the household server password to link this agent.',
    fallbackAgentName: 'Agent',
  },
  // You own your id conventions and the props the agent later sees.
  buildIdentity: ({ agentName }) => ({
    client: { id: `cl-mcp-${agentName}`, name: agentName },
    oauth: {
      userId: `us-mcp-${agentName}`,
      props: { role: 'agent', agentName },
    },
  }),
});
```

- **`branding`** controls the form's title (it receives the connecting agent's declared name), subtitle, and a fallback name.
- **`buildIdentity`** is called once per successful authorize, *after* the password check passes. It lets the deploy package own its id conventions (e.g. `us-mcp…`, `cl-…`) and choose the shape of the `props` its agent sees on every subsequent request.

You mount this inside your `OAuthProvider`'s `defaultHandler`; every `/authorize` request routes here. The form itself is a clean, self-contained HTML page with light/dark support — no asset pipeline required.

## Advertising the capability

Tell clients the server speaks MCP by merging a flag into `GET /info`:

```ts
export default createSyncApp({ info: { mcp: true } });
```

```json
// GET /info
{ "name": "Our Household", "protocolVersion": 2, "realtime": true, "mcp": true }
```

Reserved keys (`name`, `protocolVersion`, `realtime`) can't be overridden; everything else in `info` is yours to advertise.

## The big picture

```
            ┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
            │                                                                          │
  client ──▶│  createSyncApp  ──▶  D1 (documents)  ◀──  Store(D1Adapter)  ◀──  MCP tool │
  (HTTP)    │       │                    ▲                                    (agent)   │
            │       └── RealtimeDO ──────┘  broadcast invalidations                     │
            │  createOAuthAuthApp  ──▶  registers agent as a normal client row          │
            └──────────────────────────────────────────────────────────────────────────┘
```

A client and an agent are symmetric: both authenticate with the shared password, both end up as a `clients` row, and both read and write the same D1 documents through a `Store`. The only difference is that the client reaches the Store over HTTP while the agent holds one in-process.
