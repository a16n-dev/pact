# Introduction

Pact is an intentionally simple way to build **local-first apps** that can grow into **realtime collaboration** for a small group of individuals and agents in a **high-trust environment**. The defining idea is a two-step path:

1. **Build a client-only app.** Everything ships in `@a16n/pact-client` — local CRUD, optimistic writes, blobs, migrations, backups — fully functional offline, with no server.
2. **Extend with a server when you want to collaborate.** Deploy `@a16n/pact-server` and your existing app syncs across devices, users, and agents in realtime. The app code doesn't change; sync is additive.

You don't pick an architecture up front. You start local and add the server the moment a single device stops being enough.

## The two packages

| Package | Runs where | Purpose |
|---------|-----------|---------|
| `@a16n/pact-client` | App / CLI / in-Worker | The `Store` — local CRUD, optimistic writes, blobs, migrations, backups. Sync and realtime activate once a server is configured. |
| `@a16n/pact-server` | Cloudflare Workers | The **optional** sync HTTP layer as a composable Hono app, backed by D1 (documents) and R2 (blobs), with a Durable Object for realtime fan-out. |

`@a16n/pact-server` depends on `@a16n/pact-client` for shared types (`BaseDocument`, `DatabaseAdapter`), so the same `Store` can run *inside* the Worker on top of D1 — letting agent/tool code and client code share repositories built on one Store API.

## What you get

- **Local-first, standalone** — a complete app runs on `@a16n/pact-client` alone; the server is something you add later, not a prerequisite.
- **Offline first** — clients function fully offline even after you add a server; sync is additive and never on the critical path.
- **Realtime** — once a server is in place, clients are notified of changes as they land, enabling realtime collaboration.
- **Agents as first-class users** — build MCP tools directly into the server so agents read and write the same data clients do, in realtime.
- **JSON document + blob storage** — store (and, with a server, sync) structured documents alongside images and other files.

## How the pieces fit

```
┌─────────────────┐         HTTP push/pull          ┌──────────────────────┐
│   @a16n/pact-client  │  ─────────────────────────────▶ │     @a16n/pact-server     │
│                 │                                  │   (Hono on Workers)  │
│   Store         │  ◀───── WebSocket invalidations ─│                      │
│   ├ adapter     │                                  │   ├ D1   (documents) │
│   ├ blobAdapter │                                  │   ├ R2   (blobs)     │
│   └ domain      │                                  │   └ RealtimeDO (WS)  │
└─────────────────┘                                  └──────────────────────┘
        │                                                       ▲
        │  same Store API, backed by D1Adapter                  │
        └───────────────  in-Worker agent / MCP tools ──────────┘
```

Every mutation is written locally first and pushed in the background. The server reconciles with last-write-wins and (optionally) broadcasts a lightweight invalidation so other clients pull what changed.

## Where to go next

- **Step 1 — build the app.** Start with [Client Setup](/guide/client-setup); it's all you need for a working local-first app.
- New to the model? Read [Concepts](/guide/concepts) and [The Document Model](/guide/document-model).
- **Step 2 — add collaboration.** When you're ready, stand up the backend in [Deployment (Cloudflare)](/server/deployment).
- Wiring up an agent? See [Agents & MCP](/server/mcp).
