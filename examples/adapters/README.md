# Adapter recipes

Pact's `Store` persists documents through a `DatabaseAdapter` you supply — a small interface (`get` / `getMany` / `getAll` / `put` / `delete` / `wipe` / `listCollections`, plus optional `putMany`) over whatever storage your platform has. The framework ships only an `InMemoryAdapter`; this package is a set of **copy-paste implementations for real storage backends**.

These are recipes, not a published package: copy the one file you need into your app and adapt it. Each is self-contained (imports only from `@a16n/pact-client` and, where noted, its platform's stdlib) and covered by the shared contract test in this repo.

| Recipe                                                   | Platform            | Backend                           | Use when                                                                                                                        |
| -------------------------------------------------------- | ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`localStorageAdapter.ts`](./src/localStorageAdapter.ts) | Web                 | `localStorage` / `sessionStorage` | Small apps and prototypes; data comfortably under the ~5 MB Storage quota.                                                      |
| [`indexedDbAdapter.ts`](./src/indexedDbAdapter.ts)       | Web                 | IndexedDB (raw, no wrapper lib)   | The web default: async, effectively unbounded, works in workers.                                                                |
| [`jsonFileAdapter.ts`](./src/jsonFileAdapter.ts)         | Node                | One JSON file                     | CLIs and scripts where a human-readable data file is a feature.                                                                 |
| [`nodeSqliteAdapter.ts`](./src/nodeSqliteAdapter.ts)     | Node ≥ 22.5         | `node:sqlite` (built-in)          | Node/desktop apps with real data volumes; zero dependencies. Renames trivially to `better-sqlite3`.                             |
| [`expoSqliteAdapter.ts`](./src/expoSqliteAdapter.ts)     | React Native / Expo | `expo-sqlite`                     | Mobile apps. Typed structurally so this repo compiles it without Expo; swap in the real `SQLiteDatabase` type when you copy it. |

For a working app wired to one of these, see [`../todo-cli`](../todo-cli), which uses a copy of the JSON-file recipe.

## Writing your own

The contract is small, and the `Store` does the clever parts — an adapter is dumb storage by design. The rules:

- **Store documents verbatim.** No validation, no migration, no filtering. In particular, soft-deleted docs (`deletedAt` set) are stored and returned like any other — the Store filters tombstones, and sync depends on them surviving.
- `get` of a missing doc returns `null`; `getAll`/`getMany` of a missing collection return `[]`; `delete` of a missing doc is a no-op.
- `put` is an upsert keyed `(collection, id)`.
- `putMany` is optional — implement it when your backend can batch (one transaction / one write); the Store falls back to sequential `put` when it's absent.
- `wipe` clears everything, including internal `_*` collections (credentials, cursors, outbox).
- `listCollections` lists every collection that currently has data, internal `_*` ones included.
- Collection names and ids are arbitrary strings — if your backend embeds them in keys (see the localStorage recipe), encode them so a separator character can't collide.

To hold your implementation to the same suite these recipes pass, copy [`adapterContract.ts`](./src/adapterContract.ts) too:

```ts
import { describeAdapterContract } from './adapterContract';

describeAdapterContract('MyAdapter', async () => ({ adapter: new MyAdapter(...) }));
```

## Blobs

Binary attachments go through a separate, equally small `BlobAdapter` (content-addressed: keys are SHA-256 hashes). The same recipes apply conceptually — a table/store/directory keyed by hash. See the [Blobs guide](../../packages/docs/guide/blobs.md).

## Running the tests here

```bash
pnpm install        # repo root
pnpm --filter @a16n/pact-adapter-recipes test
```

The browser recipes run against stand-ins (`fake-indexeddb`, an in-memory `Storage` stub); the expo-sqlite recipe runs its SQL for real through a `node:sqlite` shim.
