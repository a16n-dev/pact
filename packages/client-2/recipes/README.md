# Recipes

Copy the file you need into your app; none of these are package exports. Each imports only from `@a16n/pact-client` and declares its platform dependency structurally so this repo compiles it without the platform installed. Replace those structural types with the real ones when you copy it.

## Adapters

| Recipe                                                                             | Platform            | Backend                      |
| ---------------------------------------------------------------------------------- | ------------------- | ---------------------------- |
| [`adapters/expoSqliteAdapter.ts`](./adapters/expoSqliteAdapter.ts)                 | React Native / Expo | `expo-sqlite`                |
| [`adapters/expoFileSystemBlobAdapter.ts`](./adapters/expoFileSystemBlobAdapter.ts) | React Native / Expo | `expo-file-system` (SDK 52+) |
| [`adapters/indexedDbAdapter.ts`](./adapters/indexedDbAdapter.ts)                   | Web                 | IndexedDB                    |
| [`adapters/opfsBlobAdapter.ts`](./adapters/opfsBlobAdapter.ts)                     | Web                 | Origin private file system   |

A `DatabaseAdapter` is dumb storage keyed by `(collection, id)` holding a JSON value it never reads. `get` of a missing record returns `null`, `getAll` and `getMany` return `{ id, record }` entries, `put` is an upsert, `putMany` is optional, `wipe` clears everything including the internal `_*` collections, and `listCollections` lists every collection that has data.

A `BlobAdapter` is a directory keyed by SHA-256 hash that also remembers each blob's MIME type.

## Sign-in

| Recipe                                 | Platform |
| -------------------------------------- | -------- |
| [`sign-in/web.ts`](./sign-in/web.ts)   | Browser  |
| [`sign-in/expo.ts`](./sign-in/expo.ts) | Expo     |

Both wrap `store.sync.beginSignIn` and `store.sync.completeSignIn`; the difference is how the browser gets opened and how the redirect comes back.
