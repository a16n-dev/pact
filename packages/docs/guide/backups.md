# Backups

Pact can pack the entire local store — documents *and* blob bytes — into a single portable archive, and restore it on another device or after a wipe. It's a snapshot you own: no server round-trip required.

## Pack and restore

```ts
const bytes = await store.createBackup(); // Uint8Array — a complete, portable snapshot
// ...write it to a file, hand it to the user, stash it somewhere safe...

await store.restoreBackup(bytes); // rehydrate documents + blobs into the local store
```

`createBackup()` returns a self-contained binary blob; `restoreBackup()` reads one back in.

Blobs are bundled by default when the store has a [BlobAdapter](/guide/blobs). For a documents-only archive (blobs can be re-pulled from a sync server later via their referenced hashes), pass `{ blobs: false }`:

```ts
const docsOnly = await store.createBackup({ blobs: false });
```

## What's in the archive

The archive is a binary container:

- A **magic sentinel** (`PBK1`) identifying the format and version.
- A **manifest** (JSON) of all documents, grouped by collection.
- The **blob bytes** referenced by those documents, with their hash + MIME type metadata.

Blobs are stored by their content hash (the same SHA-256 used everywhere — see [Blobs](/guide/blobs)), so a backup is internally deduplicated and a restore can skip bytes it already has.

## What's excluded

Pact's internal bookkeeping collections are **not** included:

| Excluded | Why |
|----------|-----|
| `_config` | Holds this device's identity, sync URL, and token — device-specific, not data. |
| `_sync_meta` | Per-collection "last pulled at" cursors — meaningless on another device. |
| `_outbox` | Pending local writes — transient sync state. |

Note that on an [encrypted store](/guide/encryption), backups still export **plaintext** — the archive reads through the decrypting layer. Treat backup files with the same care as the data itself.

The result is that a backup captures **your data**, not your device's sync state. Restoring it onto a fresh client gives you the documents and files back; you still [connect and claim an identity](/guide/authors-identity) on that client as a separate step.

::: tip Backups vs. sync
Sync keeps live clients converged through the server. A backup is an *offline, self-contained* copy — useful for cold archival, migrating to a new device without a server, or exporting data out of Pact entirely. The two are complementary: sync is the live channel, backup is the snapshot.
:::

## Restore modes

`restoreBackup` takes a `mode`, defaulting to `merge`:

| Mode | Behavior |
|------|----------|
| `merge` *(default)* | Last-write-wins, mirroring the [pull path](/guide/sync). A restored document overwrites the local copy only when the local one isn't strictly newer; ties go to the archive. Safe to run against a live store. |
| `replace` | Clears each restored collection first, then writes the archive's documents. Use for a clean rehydrate onto an empty or known-stale device. |

```ts
await store.restoreBackup(bytes, { mode: 'replace' });
```

Documents are written **raw** — audit fields and `schemaVersion` survive intact, and reads migrate them lazily just like pulled docs. Restored documents reach a sync server on the next `pushAll`. `restoreBackup` returns a summary of how many documents and blobs were written vs. skipped.
