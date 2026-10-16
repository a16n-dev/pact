# Pact 2 client scope

The client half of Pact 2, built against `packages/server-2/api.md`. Lives at `packages/client-2`; the Pact 1 client stays in `deprecated/client`. Published as `@a16n/pact-client` major version 2.

## Carried over from Pact 1

Unchanged in intent and public shape unless listed under a later section:

- `defineCollection` with zod schemas, id prefixes, `date()`, `docId()`, `key` aliasing, `synced: false`, `withIndexes`.
- `Store.create({ adapter, collections, ... })`, `store.collection(name)` with `get`, `getMany`, `list`, `create`, `update`, `upsert`, `delete`, the `...Many` forms, `includeDeleted`, `listByIndex`.
- Soft deletes as tombstones.
- Lazy migrations on read.
- `DatabaseAdapter`, `InMemoryAdapter`, `BlobAdapter`.
- End-to-end encryption via an injected `DocCipher`, `createWebCryptoCipher`, `deriveEncryptionKey`, the startup key check, `encryption.verifyKey()`, `encryption.encryptLocal()`.
- Blobs: `write`, `uri`, `has`, `list`, `delete`, `push`, `pull`, `pullReferenced`, `referencedHashes`, `prune`, `notifyChanged`, `blobFields`.
- Backups: `backup.create`, `backup.restore` with `merge` and `replace`.
- `store.on('change', collection)`.
- Outbox written to local storage before any network call; drain coalescing.
- Realtime reconnect with exponential backoff, pull on every open.

## Removed

- `store.author` (`get`, `set`, `reassignLocal`, `wipe`), `LOCAL_AUTHOR_ID`, `SYSTEM_AUTHOR_ID`, `onSetAuthor`.
- `createdBy`, `updatedBy`, `deletedBy` on the base document.
- `sync.register(url, password, appName, clientName)` and the app password.
- Per-collection sync cursors and `collection.pull` / `collection.pullAll`.
- The `/info` probe.
- The `onUndecryptable` option. See Encryption for the single behaviour that replaces it.
- Seeds (`store.seed`, `SeedSet`).

## Document model

### Base document

```ts
{
  id: string;
  createdAt: string; // ISO, immutable
  updatedAt: string; // ISO, derived on read from the greatest field clock, not stored
  deletedAt: string | null;
}
```

### Merge mode

`defineCollection` takes `merge: 'field' | 'document'`, defaulting to `field`.

- **Field**: one clock per field; fields merge independently.
- **Document**: one clock per record; the record with the greater clock wins wholesale. Text fields are not allowed.

### Clocks

- In a field-level collection every document carries one hybrid logical clock per field, including `deletedAt`. In a document-level collection it carries one clock. `id` and `createdAt` are immutable and carry no clock.
- An HLC is `(wallMs, counter, node)`. `node` is the install id: a random id generated on first use, persisted in `_config`, and also used as the OAuth `device_id`.
- An HLC encodes to a fixed-width string that sorts lexicographically in causal order and fits the server's 64-char `hlc` limit.
- The store keeps one HLC instance, advanced on every local write and on every received clock.
- A received clock more than 60 seconds ahead of local wall time is rejected and the version is skipped (see Skipped versions).
- A text edit stamps a clock on the text field. It drives `updatedAt` only and plays no part in merging.
- A local write stamps the written fields, or the record in a document-level collection, with a fresh clock. Fields not in the write keep their clocks.

### Field types

A collection schema field is one of:

- **Plain** (default): last-writer-wins by field clock. Any zod type the Pact 1 `Storable` constraint allows. A field is a top-level schema key; arrays and nested objects merge as one value.
- **Text**: a Yjs `Y.Text`. Declared with a `yText()` helper in the schema. Projects to `string` on the typed document for reads; edits go through the Yjs type.

Yjs is an optional peer dependency, exposed through the `@a16n/pact-client/yjs` subpath. A store whose collections declare no text fields never loads it.

### Text editing

- `collection.text(id, field)` → `Y.Text` owned by the store. The same instance is returned while the document is loaded; it reflects pulled changes as they merge.
- Every Yjs transaction on it is persisted as a local write immediately. The outbox push is debounced by 1 second per document.
- `create`, `update` and `upsert` accept a `string` for a text field and apply it as a replace-all edit.
- Awareness, cursors and presence are not provided.

### Merge

Merging two records of the same document:

- Document-level collection: the record with the greater clock wins, `deletedAt` included.
- Plain field: the value with the greater clock wins. Equal clocks are impossible across installs; within an install the later write wins.
- Text field: Yjs update merge.
- `deletedAt` is a plain field, so delete and undelete resolve by clock like any other field.
- `createdAt`: the earlier value.
- `schemaVersion`: the greater value.

The merge is commutative and idempotent. The local store holds only the merged record, never other writers' versions. A merge that leaves the record unchanged neither persists nor emits `change`.

Writes and merges to one document are serialised, so a local write during a pull of the same document is applied after the merge.

### Skipped and held versions

A pulled version is **skipped** when its clock is beyond the drift bound or its envelope fails to open. It is not stored, nothing is logged, and the cursor advances.

A pulled version is **held** when its `schemaVersion` is newer than this client's definition or its fields fail validation. The record is stored as-is, hidden from reads, and not merged until a client upgrade can migrate or validate it. A held record is still pushed by `push()`.

`sync.pull()` returns `{ applied: number; skipped: { drift: number; sealed: number }; held: number }`.

### Stored record

The adapter stores one record per document:

```ts
{
  schemaVersion: number;
  fields: { ...typed document fields },
  clocks: { [field]: string },   // encoded HLCs; field-level collections
  clock?: string;                // encoded HLC; document-level collections
  text?: string;                 // base64 Yjs document state, present only when the collection has text fields
}
```

`DatabaseAdapter` is keyed by `(collection, id)` and stores this record. Reads project `fields`, a `string` for each text field, and the derived `updatedAt` into the typed document. `schemaVersion` is not on the typed document.

### Migrations

- Run on read as in Pact 1, over `fields`.
- A field present before and after a migration keeps its clock. A field the migration produces takes the record's greatest clock. Document-level records keep their clock.
- Changing a collection's merge mode is not supported.
- Migrations may not add, rename, or remove text fields.

### Wire format

- `data` is the JSON of the stored record, or the encryption envelope sealing that JSON.
- `hlc` is the record's greatest clock.
- `collection` is the definition's `key`.

### Limits enforced client-side

- `data` over 1 MB after encoding fails the write with an error naming the document. It is never queued. Text field state counts toward the limit.
- `collection` key and `id` are checked against 1–256 chars at `defineCollection` and on write.

## Sync

### Session

- `sync.beginSignIn({ url, appId, deviceName, redirectUri })` → `{ authorizeUrl, state }`. Generates and holds the PKCE verifier and state, persists `deviceId` on first use, fetches `/.well-known/pact` for the authorize and token URLs and `max_push_documents`.
- `sync.completeSignIn({ code, state })` → `{ ok: true } | { ok: false, reason }`. Verifies `state`, exchanges the code, persists `{ url, appId, deviceId, deviceName, token, maxPushDocuments }` in `_config`, starts the sync loop and realtime.
- `sync.signOut()`: `POST /auth/signout`, then forgets the token and closes realtime. Local data is kept.
- `sync.session()` → `{ appId, user: string | null, deviceName } | null`. Calls `GET /auth/check` and returns its result; null when not signed in.
- `sync.registration()` → `{ url, appId, deviceId, deviceName } | null` from local config, no network.
- `sync.credentials()` → `{ url, token } | null`.
- On startup a persisted token is validated with `GET /auth/check`.
- Any 401 from any endpoint, or a realtime close with code 1000 and reason `signed out`, clears the token, stops sync and realtime, and emits `store.on('signedOut')`.

Sign-in recipes ship as copyable files, not package exports:

- Web: redirect to `authorizeUrl`, read `code` and `state` from the landing URL, call `completeSignIn`.
- Expo: `expo-auth-session` with a private-use scheme redirect.

### HTTP

- Every request has a 15 second timeout via `AbortController`.

### Pull

- One cursor per store, persisted in `_config` as it advances per page.
- `sync.pull()`: `GET /sync/pull?cursor=` until `hasMore` is false. Each version is merged into the local record by the rules above and persisted through the store's write path so indexes update. Versions whose `collection` has no definition or is `synced: false` are skipped. Emits `change` once per collection touched.
- `sync.pullDocument(collection, id)`: fetches every version of one document, merges them all into the local record, and returns the result. Does not move the cursor.
- One pull in flight at a time. A pull requested during a pull runs once more after it, as the outbox drain does.
- Reads (`get`, `getMany`, `list`) trigger a throttled store-wide pull, as in Pact 1 but no longer per collection.
- `sync.resync()`: drops all local state except `_config`, resets the cursor to 0, pulls.
- `sync.lastSyncedAt()` → `Date | null`: when this device last completed a full pull.
- `_config` records which collection keys have been pulled. On startup and on sign-in, every synced definition whose key is not in that set is backfilled with `GET /sync/pull?cursor=0&collection=<key>` to completion before the store-wide loop runs, then added to the set.

### Push

- `sync.drain()`: reads the outbox in order, loads each entry's current record, encodes it, and pushes in chunks of `max_push_documents`. A chunk may mix collections. Outbox entries clear per successful chunk. A failed chunk stops the drain and leaves its entries and all later ones queued.
- `sync.push()`: drain, then push every record in every synced collection in chunks. Recovery only; routine paths use `drain()`.
- `sync.pending()`: outbox size.
- Writes made before sign-in are queued and pushed on the first drain after sign-in.

### Realtime

- `GET /realtime?token=` opened on sign-in and on store startup with a stored token.
- On `{ type: 'changed', seq }`: pull unless `seq` equals the local cursor.
- On open: pull, then drain.
- Reconnect with backoff on any close other than signed-out.

### Blobs

- Same endpoints and `BlobSync` behaviour as Pact 1.
- A write over 50 MB fails locally with an error.
- 401 routes into the signed-out handling.

### AI

Nothing beyond `sync.credentials()`, which gives an app the origin and token to point an OpenAI-compatible SDK at `<origin>/ai`.

## Encryption

- Seals the stored record's JSON. `hlc`, `collection` and `id` stay cleartext on the wire.
- Blob bytes and `_config` are not encrypted.
- Merging happens on decrypted records; the server never reads inside `data`.
- A pulled version whose envelope fails to open is skipped (see Skipped and held versions).
- A store therefore sees only documents sealed under its own key. Clients holding different keys in one app partition its documents; they never merge across keys and `resync()` is the only way to see documents skipped earlier. Blobs are shared across keys.
- Rotating a key means `encryptLocal()` then `push()` on one client, the new key then `resync()` on every other client.
- The startup sentinel catches a wrong key only on an install that already holds data. A fresh install opens with any key.

## Backups

- The archive carries stored records (fields, clocks, text state), so restore is the same merge as sync.
- `replace` mode clears and loads verbatim as in Pact 1.

## Internal collections

- `_config`: `client` (registration and token), `node` (HLC node id), `cursor`, `pulledCollections`, `lastSyncedAt`, `encryption` sentinel.
- `_outbox`: `(collection, id)` references in write order.

## Deliverables beyond the package

- Adapter recipes as copyable files: Expo SQLite `DatabaseAdapter` with a file-system `BlobAdapter`; IndexedDB `DatabaseAdapter` with an OPFS `BlobAdapter`.
- An in-memory fake server implementing `api.md`, used by the test suite.
- A README. No docs site in this version; `deprecated/docs` stays as is.

## Server changes to consider

- A pull parameter to exclude the caller's own versions, so a client's pushes don't echo back on its next pull. The returned `cursor` must still advance past them.
- Include `writer_id` in the realtime `changed` message, so a client can skip the pull when the only new versions are its own.
- A byte limit per push batch alongside `max_push_documents`, so a client can size chunks for large records.

## Out of scope

- Per-document or per-user access control.
- Storing other writers' versions locally.
- Pruning old versions on the server.
- Token refresh.
- A packaged browser or native sign-in helper.
- Migrating Pact 1 data, archives, or adapters.
