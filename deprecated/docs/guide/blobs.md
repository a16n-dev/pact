# Blobs

Blobs (images, files) are a **content-addressed sidecar** to the document store. Keys are the **SHA-256 hex digest of the bytes**, so identity falls out of content:

- Writes are **idempotent** — writing the same bytes twice is a no-op.
- Dedupe is **automatic** — the same image referenced by ten documents is stored once.
- "Same blob?" is a **string comparison** of two hashes.

Documents reference blobs by hash; the bytes live separately, synced on their own schedule.

## The BlobAdapter

The `BlobAdapter` is optional — pass `null` for JSON-only consumers like CLIs. When present, it's the local store for blob bytes:

```ts
interface BlobAdapter {
  has(hash: string): Promise<boolean>;
  read(hash: string): Promise<Uint8Array | null>;
  mimeType(hash: string): Promise<string | null>; // stored MIME type, or null when unknown
  write(hash: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  delete(hash: string): Promise<void>;
  list(): Promise<string[]>;
  uriFor(hash: string): string | null; // renderable URI (e.g. file://) when present locally
}
```

`uriFor` is the bridge to rendering: it returns a URI you can hand to an `<img>` tag or native image view when the blob exists locally (e.g. `file://…`), or `null` when it doesn't — at which point you fetch it from the server and write it through the adapter.

## On the server

Bytes live in **R2**, keyed by hash. A `blobs` registry table in **D1** records existence + metadata (mime / size / createdAt) so you can answer "do we have this blob, and how big is it?" **without fetching the bytes**.

| Path | Purpose |
|------|---------|
| `GET /sync/blobs` | The authoritative set of stored blob hashes. |
| `PUT /sync/blobs/:hash` | Upload bytes (`:hash` must be the SHA-256 of the body). |
| `GET /sync/blobs/:hash` | Download bytes. |

See the [HTTP API reference](/reference/http-api) for the full route table.

## Syncing blobs

Blob sync is a **set difference**, not a timestamp delta:

1. The client `GET /sync/blobs` to fetch the authoritative hash set.
2. It diffs that against its local cache (`adapter.list()`).
3. Missing-locally hashes get pulled (`GET /sync/blobs/:hash`); missing-remotely hashes get pushed (`PUT /sync/blobs/:hash`).

Because the key *is* the content hash, there's never a conflict to resolve — a hash either exists on both sides or it doesn't. Uploads are idempotent, so re-running the diff is always safe.

::: tip Why content addressing
By making the bytes their own identity, Pact gets dedupe, idempotent uploads, integrity checking, and conflict-free blob sync for free — all from one rule: *the key is the SHA-256 of the bytes.* The document store and the blob store stay cleanly decoupled; documents just carry hashes.
:::

## Declaring which fields hold blob hashes

The document store treats your docs as opaque bags, so it can't know which fields carry blob hashes unless you tell it. Declare that on the domain with `blobHashes` — a function from `(collection, doc)` to the hashes that doc references. For the common case of flat top-level fields, the `blobFields` helper writes it for you:

```ts
import { blobFields } from '@a16n/pact-client';

const domain = {
  collections: [recipes], // the defineCollection list
  blobHashes: blobFields({ recipes: ['imageContentHash'] }),
};
```

When references are nested, in arrays, or parsed out of a body, write the function by hand — it just has to yield every hash a doc points at:

```ts
const domain = {
  blobHashes: (collection, doc) =>
    collection === 'recipes' ? (doc as Recipe).steps.flatMap((s) => s.imageHashes) : [],
};
```

This one declaration powers both reference-driven pull and garbage collection.

## Pulling only what's referenced

With `blobHashes` declared, the client can pull exactly the blobs the local document set needs — no manual hash gathering:

```ts
await blobStore.pullReferenced(); // pulls referenced-but-missing blobs
```

It's a thin wrapper over `store.referencedBlobHashes()` (the union of hashes across all **live** docs) fed into `blobStore.pull`.

## Garbage-collecting unreferenced blobs

Deleting a document doesn't delete its blob — content addressing means the same blob may be referenced elsewhere, and deletes are soft (a tombstone, which doesn't count as a reference). To reclaim space, `pruneBlobs` deletes every local blob no live document references:

```ts
const { deleted } = await store.pruneBlobs(); // ['<hash>', …]
```

Two things to know:

- **It's local-only by design.** The server's bucket is never touched. A shared, content-addressed blob can be referenced by *another* device, and last-write-wins gives no safe moment to know every client has dropped the reference — so deleting server-side could orphan a live doc elsewhere. A locally-pruned blob simply re-pulls if a referencing doc arrives later.
- **It refuses to run without a `blobHashes` extractor.** With no notion of "referenced," every blob would look like an orphan, so `pruneBlobs` throws rather than wipe your blob set.
