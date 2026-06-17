---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: Pact
  text: Build local, then collaborate
  tagline: The fast way to build local-first apps — for yourself, your family, your friends, your agents, and your cat.
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
  - icon: 🚀
    title: Local-first from day one
    details: No backend to provision — local reads and writes return instantly, so the app feels fast from the first line of code.
  - icon: 🤝
    title: Collaboration at your fingertips
    details: Spin up a server and share your data across devices — the same app you already built, now synced in realtime and collaborating with everyone you invited.
  - icon: 🤖
    title: Agents are people too
    details: Give your agents the same Store your app uses. They read and write the same data as the humans, at the same time, with no special-case plumbing.
  - icon: 🐱
    title: Documents and blobs
    details: Store structured JSON documents and large binary files together — your shopping list and the 4MB photo of your cat live happily in the same little world.
  - icon: 🧬
    title: Change your mind freely
    details: Reshape your data as you go — old documents catch up the moment you read them, no migration step in the way.
  - icon: ☁️
    title: A backend in one command
    details: When you're ready for a server, it's one deploy to Cloudflare. No ops, no cluster, no pager — and it costs nothing while it sits idle.
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

Pact deliberately [trades generality for simplicity](/guide/concepts#design-assumptions). It's a great fit when you want to **build fast** and **start local, then grow into collaboration** for a small, high-trust group — you, your family, your friends, your agents, your cat — where last-write-wins is good enough. It is **not** the right tool for high-contention concurrent editing, per-document access control, or untrusted multi-tenant deployments.
