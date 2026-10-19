import type { BlobAdapter } from '../blobs/blobAdapter';

export type StoreBackup = {
  /**
   * Packs every stored record, tombstones included, into a portable archive,
   * bundling local blobs by default when a blob adapter is present.
   * Internal `_*` state never travels.
   */
  create(opts?: { blobs?: boolean }): Promise<Uint8Array>;
  /**
   * `merge` (the default) runs each archived record through the same merge
   * as sync, so it is safe on a live or partially-synced store. `replace`
   * clears every collection the archive carries, and all blobs if it holds
   * any, then loads it verbatim.
   */
  restore(archive: Uint8Array, opts?: { mode?: RestoreMode }): Promise<RestoreResult>;
};

export type RestoreMode = 'merge' | 'replace';

export type RestoreResult = {
  mode: RestoreMode;
  /** Collections present in the archive. */
  collections: string[];
  /** Archive collections this Store has no definition for; their docs were not restored. */
  collectionsSkipped: string[];
  docsWritten: number;
  /** Merge only: records that changed nothing locally, or were held for a newer schema. */
  docsSkipped: number;
  blobsWritten: number;
  /** Blobs in the archive that could not be restored because the store has no blob adapter. */
  blobsSkipped: number;
};

/**
 * Content-addressed: the key is the SHA-256 of the bytes, so writes are
 * idempotent and dedupe automatically. Requires `StoreOptions.blobs`; the
 * methods that touch bytes throw without one.
 */
export type StoreBlobs = {
  /** null on doc-only stores. */
  readonly adapter: BlobAdapter | null;
  /**
   * Hashes, writes locally, and best-effort pushes to the sync server.
   * Returns the SHA-256 hex digest, which is the blob's identity in every
   * layer. A failed push is retried by `push()`. Bytes over 50 MB are refused.
   */
  write(bytes: Uint8Array, mimeType: string): Promise<string>;
  /** Renderable URI (e.g. `file://…`), or null when the blob is not held locally. */
  uri(hash: string): string | null;
  /** Whether the blob is held locally. */
  has(hash: string): Promise<boolean>;
  /** Hashes of every blob held locally. */
  list(): Promise<string[]>;
  /**
   * Local-only, like `prune`: the server's copy stays, so a document still
   * referencing this hash re-pulls it on the next sync.
   */
  delete(hash: string): Promise<void>;
  /**
   * Uploads the local blobs the server lacks: one round trip for the
   * server's hash set, then PUTs the difference. Idempotent.
   */
  push(): Promise<void>;
  /** Downloads the named blobs where missing locally. Prefer `pullReferenced`. */
  pull(referencedHashes: Iterable<string>): Promise<void>;
  /**
   * Downloads every blob the local documents reference but do not hold.
   * Downloads nothing without a `StoreOptions.blobHashes` extractor.
   */
  pullReferenced(): Promise<void>;
  /** Union of hashes referenced by every live document; empty without an extractor. */
  referencedHashes(): Promise<Set<string>>;
  /**
   * Deletes local blobs no live document references. Local-only: other
   * devices may still reference a blob, so the server's bucket is untouched.
   * Throws without a `blobHashes` extractor; no-op without a blob adapter.
   */
  prune(): Promise<{ deleted: string[] }>;
  /**
   * Signals a local blob-set change made outside these methods (a direct
   * adapter write, an out-of-band delete). Routed through the `change`
   * channel as `_blobs` so UI invalidation can hang off one subscription.
   */
  notifyChanged(): void;
};

export type StoreEncryption = {
  /**
   * Verifies, or writes on first encrypted use, the sealed sentinel in
   * `_config/encryption` so a wrong key fails fast. `Store.create` calls this
   * automatically; no-op without encryption. A fresh install opens with any key.
   */
  verifyKey(): Promise<void>;
  /**
   * One-time sweep to enable encryption on an existing install: rewrites
   * every record through the cipher. Idempotent. Follow with `sync.push()`
   * to convert the server's copies.
   */
  encryptLocal(): Promise<{ rewritten: number }>;
};
