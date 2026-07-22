---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: Pact
  text: Build local, then collaborate
  tagline: The fast way to build local-first apps — for yourself, your family, your friends, your agents, and your cat.
  actions:
    - theme: brand
      text: Start Building
      link: /guide/introduction
    - theme: alt
      text: Server Setup
      link: /server/deployment

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
    title: Blob support included
    details: Apps look better with photos! A content-addressed Blob store gives you the same offline-first, sync later API for images and other binary data
  - icon: 🧬
    title: Change your mind freely
    details: Reshape your data as you go — old documents catch up the moment you read them, no migration step in the way.
  - icon: ☁️
    title: Serverless on Cloudflare
    details: When you're ready for a server, it's one deploy to Cloudflare. No ops, no cluster, no pager — and it costs nothing while it sits idle.
---

## Is Pact for you?

Pact deliberately [trades generality for simplicity](/guide/concepts#design-assumptions). A quick gut check:

<div class="pact-fit">
  <div class="pact-fit-card pact-fit-yes">
    <h3>👍 Likely a great fit</h3>
    <p>If you answer <strong>yes</strong> to most of these:</p>
    <ul>
      <li>Building for a small, high-trust group — you, your family, your friends, your agents?</li>
      <li>Want it to work offline and feel fast, with sync as a later add-on?</li>
      <li>Is last-write-wins good enough for your data?</li>
      <li>Would you rather start building today than stand up infrastructure first?</li>
    </ul>
  </div>
  <div class="pact-fit-card pact-fit-no">
    <h3>👎 Probably the wrong tool</h3>
    <p>If you answer <strong>yes</strong> to any of these:</p>
    <ul>
      <li>Do you need per-document access control, or untrusted users?</li>
      <li>Will people routinely edit the same field at the same moment and need every change merged?</li>
      <li>Are you shipping multi-tenant SaaS to the public?</li>
    </ul>
  </div>
</div>

<style>
.pact-fit {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 20px;
}
@media (max-width: 640px) {
  .pact-fit { grid-template-columns: 1fr; }
}
.pact-fit-card {
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  padding: 4px 20px 12px;
  background: var(--vp-c-bg-soft);
}
.pact-fit-card h3 { margin: 16px 0 4px; }
.pact-fit-card ul { padding-left: 1.1rem; }
.pact-fit-card li { margin: 8px 0; }
.pact-fit-yes { border-color: var(--vp-c-green-2); }
.pact-fit-no { border-color: var(--vp-c-yellow-2); }
</style>

## Two steps, not two rewrites

Pact is built so the same code carries you from a local prototype to a collaborative app. You don't choose an architecture up front — you grow into one.

### 1. Build a client-only app

Everything you need to ship a real app lives in `@a16n/pact-client`. The `Store` gives you local CRUD, optimistic writes, blobs, migrations, and backups — all fully functional **offline, with no server in the picture**.

```ts
import { Store, InMemoryAdapter } from '@a16n/pact-client';

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

When a single device stops being enough — a second user, another device, an agent — deploy [`@a16n/pact-server`](/server/deployment) and point your client at it. **Your app code doesn't change.** Sync is additive: the same writes that were local-only now propagate, and realtime turns on automatically when the server supports it.

```ts
const store = await Store.create(adapter, blobAdapter, domain);

await store.registerClient(serverUrl, password, 'myapp', "Alice's laptop");
await store.setAuthor('us-alice');
// ...everything you already wrote keeps working, now synced in realtime.
```

The two packages:

| Package | Runs where | Purpose |
|---------|-----------|---------|
| [`@a16n/pact-client`](/guide/client-setup) | App / CLI / in-Worker | The `Store` — local CRUD, optimistic writes, blobs, migrations, backups. Sync and realtime when a server is configured. |
| [`@a16n/pact-server`](/server/deployment) | Cloudflare Workers | The optional sync layer as a Hono app, backed by D1 + R2, with a Durable Object for realtime fan-out. |

Agents get no special-case plumbing: an agent's MCP server is **just another `@a16n/pact-client` consumer** that registers as a sync client — the same Store, the same repositories, the same realtime.
