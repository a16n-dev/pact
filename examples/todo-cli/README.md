# todo-cli — a complete Pact client app

A local-first TODO list for your terminal, built on `@a16n/pact-client`. It demonstrates the whole client story in three small files:

- [`src/domain.ts`](./src/domain.ts) — the domain: one `defineCollection` call. The schemas you hand the Store define which collections exist.
- [`src/jsonFileAdapter.ts`](./src/jsonFileAdapter.ts) — the storage adapter, copied verbatim from the [adapter recipes](../adapters) (that's how adapters are meant to be consumed).
- [`src/main.ts`](./src/main.ts) — the CLI: typed CRUD via `store.collection('todos')`, plus the optional register → author → sync flow.

The point to notice: the CRUD code is identical with and without a server. Sync is additive.

## Run it

```bash
pnpm install   # repo root
cd examples/todo-cli

pnpm todo add Buy milk
pnpm todo add Water the plants
pnpm todo list
pnpm todo done <id>     # ids abbreviate: any unique tail works
pnpm todo list --all
pnpm todo rm <id>
```

Data lives in `.pact-todo.json` in your working directory (override with `PACT_TODO_FILE`) — `cat` it to see exactly what Pact persists: your fields plus the audit/sync base fields (`createdAt`, `updatedBy`, `deletedAt`, …), and under `_config`/`_outbox`/`_sync_meta` the store's internal bookkeeping.

## Add sync (optional)

With a [pact server](../../packages/docs/server/deployment.md) deployed:

```bash
pnpm todo register https://sync.example.com <appPassword> myapp "Alex's laptop"
pnpm todo author us-alex        # claims the identity + adopts pre-sync writes
pnpm todo sync
pnpm todo status
```

Run the same app in another directory (or on another machine) with a different `PACT_TODO_FILE`, register it against the same server and app, and `todo sync` moves changes between them — last write wins, tombstones and all.

## Things to try

- Delete a todo, then look at `.pact-todo.json`: it's still there as a tombstone (`deletedAt` set). That's what makes deletes syncable.
- Make writes while "offline" (bogus server URL registered): they queue in `_outbox` and drain on the next successful `sync`.
- Swap the adapter line in `main.ts` for the [`node:sqlite` recipe](../adapters/src/nodeSqliteAdapter.ts) — nothing else changes.
