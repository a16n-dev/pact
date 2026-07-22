# Seeds

A deployment can ship **reference data** — units of measure, a recipe catalog, a starter set of tags — that every client materializes locally and identically. Syncing it would just duplicate bytes across the wire, so Pact treats seeds specially: they live on every device but **never sync**.

## How seeds are recognized

The default seed marker is:

```
createdBy === updatedBy === '_system'
```

That is: a document both created *and* last-updated by the [`_system` author](/guide/authors-identity#the-two-reserved-authors), untouched by any real user. `store.pushAll()` filters these out, so they never leave the device.

Write them with `createAsSystem`:

```ts
await store.createAsSystem('units', 'unit-gram', { label: 'gram', symbol: 'g' });
await store.createAsSystem('units', 'unit-cup', { label: 'cup', symbol: 'c' });
```

Each client runs the same seeding code at startup, so every device ends up with an identical catalog — without a single sync round-trip.

## The moment a seed is edited, it syncs

This is the elegant part. The seed marker checks `updatedBy`. The instant a **real author edits a seeded document**, `updatedBy` becomes that author's id, the document stops matching the seed rule, and it **syncs normally** from then on.

```
units/unit-cup  (createdBy: _system, updatedBy: _system)   → seed, never syncs
   ↓ alice renames it
units/unit-cup  (createdBy: _system, updatedBy: us-alice)   → now syncs everywhere
```

So shared edits to reference data propagate, while the untouched 99% stays local and free. New clients seed the original; the server holds only the deltas anyone actually changed.

## Customizing the rule

Override `isSeedDoc` in your [domain](/guide/client-setup#the-domain) if `_system` authorship isn't the right signal for your data:

```ts
const domain: StoreDomain = {
  isSeedDoc: (doc) => doc.id.startsWith('seed-'),
};
```

`pushAll` consults this predicate to decide what to skip.

## Seeds never reach the server

Some seed-only collections never reach D1 at all — they exist purely as client-side reference data. Every consumer that needs them (including an [agent's MCP Worker](/server/mcp), which is just another client) seeds its own store from the same `SeedSet`.
