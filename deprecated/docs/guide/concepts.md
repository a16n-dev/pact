# Concepts

Before the API, the worldview. Pact's simplicity comes from a few sharp assumptions — understanding them tells you exactly when Pact fits and when it doesn't.

## Design assumptions

Pact deliberately trades generality for simplicity. It assumes:

### A small, high-trust group

One server per group (e.g. a household). Authentication is a single shared server password that's traded for per-client tokens — there's **no per-document access control**. Everyone who can connect can read and write everything.

### Last-write-wins is good enough

Conflicts resolve by comparing `updatedAt` timestamps. There are **no CRDTs, vector clocks, or merge UIs**. For a small group editing mostly-disjoint data this is rarely felt; for high-contention concurrent edits to the same field it isn't the right tool.

### Schemas are owned by the consumer

Pact stores documents as opaque `BaseDocument`-shaped bags. Validation (typically Zod), migrations, and the list of collections are **injected by the consuming domain package**. Pact never inspects your document bodies except to read the base fields.

::: tip When Pact fits
A household app, a small team's internal tool, a personal knowledge base shared with a few agents. A bounded set of trusted writers, mostly-disjoint edits, and a willingness to let the newest write win.
:::

::: warning When it doesn't
Multi-tenant SaaS, untrusted users, per-row permissions, or workflows where two people routinely edit the same field at the same time and need every keystroke merged. Reach for a CRDT-based or server-authoritative system instead.
:::

## The vocabulary

| Term | Meaning |
|------|---------|
| **Store** | The single client-side entry point. Wraps an adapter + optional blob adapter + your domain and gives you optimistic CRUD that transparently syncs. |
| **Adapter** | Pluggable storage backend (`DatabaseAdapter`). In-memory for tests/CLIs, SQLite for apps. |
| **Domain** | The consumer's injection point (`StoreDomain`): the collection definitions — schemas, migrations, id prefixes — that define which collections exist, plus hooks (blob refs, author materialization, encryption). |
| **Collection** | A named bucket of documents (`recipes`, `users`). Names starting with `_` are reserved for Pact's bookkeeping and never sync. |
| **Author** | An id recording who created/updated a document. `_system` and `_local` are reserved (see [Authors & Identity](/guide/authors-identity)). |
| **Blob** | A content-addressed binary sidecar (image, file), keyed by the SHA-256 of its bytes. |
| **Seed** | Reference data every client materializes locally and identically, so it never needs to sync. |

## The data flow in one paragraph

You call `recipes.create(...)`. The Store validates the doc, stamps its `schemaVersion`, writes it to the local adapter, emits a `change` event so your UI re-reads, then fire-and-forgets a push to the server. The server upserts it into D1 with last-write-wins and — if realtime is on — broadcasts an `invalidate` to every connected client. Those clients pull the named collection and merge the change in, again last-write-wins. Nothing in that chain blocks on the network: the write was durable the instant it hit local storage.

Read on: [The Document Model](/guide/document-model) makes the `BaseDocument` shape and its consequences concrete.
