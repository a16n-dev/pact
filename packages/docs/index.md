---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: Pact
  text: Build local, then collaborate
  tagline: Start with a fully local, offline app on @pact/client. When you want realtime collaboration between people and agents, add a server — the same code keeps working.
  actions:
    - theme: brand
      text: Build a Client
      link: /guide/client-setup
    - theme: alt
      text: Add a Server
      link: /server/deployment
    - theme: alt
      text: Get Started
      link: /guide/introduction

features:
  - icon: 📴
    title: Local-first, standalone
    details: "Step 1: build a complete app on @pact/client alone. Local CRUD, optimistic writes, blobs, migrations, backups — fully functional with no server and no network."
  - icon: ⚡
    title: Add a server to collaborate
    details: "Step 2: stand up @pact/server and your existing app syncs. A Durable Object fans out invalidations over WebSockets, so clients see each other's changes in realtime."
  - icon: 🤖
    title: Agents as first-class users
    details: Build MCP tools directly into the server. Agents read and write the same data clients do — through the same Store API, with no schema divergence.
  - icon: 📦
    title: Documents + blobs
    details: Store structured JSON documents alongside images and files. Blobs are content-addressed by SHA-256, so dedupe and idempotency fall out of the bytes.
  - icon: 🧬
    title: Migrate on read
    details: Each collection carries a version chain. Old documents are walked forward as they're read, so schema upgrades drain through naturally.
  - icon: ☁️
    title: Runs on Cloudflare
    details: When you do add a server, it's a composable Hono app backed by D1 (documents) and R2 (blobs). One Worker, one Durable Object, deploy with wrangler.
---

## Two steps, not two rewrites

Pact is built so the same code carries you from a local prototype to a collaborative app. You don't choose an architecture up front — you grow into one.

### 1. Build a client-only app

Everything you need to ship a real app lives in `@pact/client`. The `Store` gives you local CRUD, optimistic writes, blobs, migrations, and backups — all fully functional **offline, with no server in the picture**.

```ts
import { Store, InMemoryAdapter } from '@pact/client';

// No server. No network. A complete, working store.
const store = await Store.create(
  new InMemoryAdapter(), // or a SQLite-backed adapter
  null, // optional BlobAdapter
  domain // validate / migrator / collections
);

const recipes = store.collection('recipes');
await recipes.create('r-123', { title: 'Soup', servings: 4 });
const live = await recipes.list(); // optimistic, offline-safe
```

### 2. Extend with a server for realtime collaboration

When a single device stops being enough — a second user, another device, an agent — deploy [`@pact/server`](/server/deployment) and point your client at it. **Your app code doesn't change.** Sync is additive: the same writes that were local-only now propagate, and a flag turns on realtime.

```ts
const store = await Store.create(adapter, blobAdapter, domain, {
  realtime: true, // ← the one addition
});

await store.registerClient(serverUrl, password, "Alice's laptop");
await store.setAuthor('us-alice');
// ...everything you already wrote keeps working, now synced in realtime.
```

The two packages:

| Package | Runs where | Purpose |
|---------|-----------|---------|
| [`@pact/client`](/guide/client-setup) | App / CLI / in-Worker | The `Store` — local CRUD, optimistic writes, blobs, migrations, backups. Sync and realtime when a server is configured. |
| [`@pact/server`](/server/deployment) | Cloudflare Workers | The optional sync layer as a Hono app, backed by D1 + R2, with a Durable Object for realtime fan-out. |

Because `@pact/server` depends on `@pact/client` for shared types, the **same `Store` can even run inside the Worker** on top of D1 — letting agent tools and client code share repositories built on one API.

## Is Pact for you?

Pact deliberately [trades generality for simplicity](/guide/concepts#design-assumptions). It's a great fit when you want to **start local and grow into collaboration** for a small, high-trust group (a household, a team, a few agents), where last-write-wins is good enough. It is **not** the right tool for high-contention concurrent editing, per-document access control, or untrusted multi-tenant deployments.
