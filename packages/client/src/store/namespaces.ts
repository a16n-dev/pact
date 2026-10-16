import type { BlobAdapter } from '../blobs/blobAdapter';
import type { RegisterResult } from '../sync/sync';

export interface StoreSync {
  /**
   * Drains the outbox, then pushes every doc in every synced collection.
   * Cost scales with the database; routine sync paths should use `drain()`.
   */
  push(): Promise<void>;
  /**
   * Drains the outbox only: retries the writes the server has not yet
   * accepted. Cost scales with the backlog, so this is what "sync now" paths
   * (app foreground, pull-to-refresh) want.
   */
  drain(): Promise<void>;
  /** Documents written locally but not yet accepted by the server. */
  pending(): Promise<number>;
  /**
   * Drops all local state except `_config`, including the outbox, then
   * re-pulls every registered collection from a fresh cursor. Callers with
   * unsynced writes that matter must `push()` first. One-off recovery for
   * when the server's docs were rewritten out-of-band.
   */
  resync(): Promise<void>;
  /** When this device last completed a pull covering all the named collections. */
  lastSyncedAt(collections: string[]): Promise<Date | null>;
  /**
   * Trades the app password for a long-lived access token. The clientId
   * persists across calls, so re-registering (to rotate a token, rename, or
   * repoint) keeps the same server-side identity.
   */
  register(
    url: string,
    password: string,
    appName: string,
    clientName: string
  ): Promise<RegisterResult>;
  /** The persisted registration with the token stripped; null when unregistered. */
  registration(): Promise<ClientRegistration | null>;
  /**
   * Raw url and access token, for helpers issuing direct HTTP calls such as
   * the blob store. App surfaces should use `registration()` instead.
   */
  credentials(): Promise<{ url: string; token: string } | null>;
  /** Forgets the registration and closes the connection. Local data is kept. */
  unregister(): Promise<void>;
}

export interface ClientRegistration {
  id: string;
  name: string;
  url: string;
  /** null when the persisted config predates multi-tenancy. */
  appName: string | null;
}

export interface StoreAuthor {
  /** `LOCAL_AUTHOR_ID` until an identity is claimed. */
  get(): Promise<string>;
  /** All subsequent writes are attributed to this id. */
  set(authorId: string): Promise<void>;
  /**
   * Re-attributes every doc still carrying the local placeholder author and
   * bumps `updatedAt` so the next push picks them up. Run after `set()` to
   * adopt writes made before the identity existed.
   */
  reassignLocal(newAuthorId: string): Promise<void>;
  /** Soft-deletes every live doc created by the author. */
  wipe(authorId: string): Promise<void>;
}

export interface StoreBackup {
  /**
   * Packs every document, tombstones included, into a portable archive,
   * bundling local blobs by default when a blob adapter is present.
   * Internal `_*` state never travels.
   */
  create(opts?: { blobs?: boolean }): Promise<Uint8Array>;
  /**
   * Docs are written raw (audit fields and `schemaVersion` survive; reads
   * migrate lazily) and reach the sync server on the next `sync.push()`.
   * `mode` defaults to `merge`.
   */
  restore(archive: Uint8Array, opts?: { mode?: RestoreMode }): Promise<RestoreResult>;
}

/**
 * `merge`: last-write-wins per document under the same strict `updatedAt`
 * rule sync uses, so it is safe on a live or partially-synced store; a blob
 * is written only when its hash is missing locally. `replace`: clears every
 * scope the archive carries (its document collections, and all blobs if it
 * holds any) before loading it verbatim. Neither mode touches internal `_*`
 * state.
 */
export type RestoreMode = 'merge' | 'replace';

export interface RestoreResult {
  mode: RestoreMode;
  /** Collections present in the archive. */
  collections: string[];
  /** Archive collections this Store has no definition for; their docs were not restored. */
  collectionsSkipped: string[];
  docsWritten: number;
  /** Skipped because a newer local copy won (merge only). */
  docsSkipped: number;
  blobsWritten: number;
  /** Blobs in the archive that could not be restored because the store has no blob adapter. */
  blobsSkipped: number;
}

/**
 * Content-addressed: the key is the SHA-256 of the bytes, so writes are
 * idempotent and dedupe automatically. Requires `StoreOptions.blobs`; the
 * methods that touch bytes throw without one.
 */
export interface StoreBlobs {
  /** null on doc-only stores. */
  readonly adapter: BlobAdapter | null;
  /**
   * Hashes, writes locally, and best-effort pushes to the sync server.
   * Returns the SHA-256 hex digest, which is the blob's identity in every
   * layer. A failed push is retried by `push()`.
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
   * Downloads nothing without a `StoreDomain.blobHashes` extractor.
   */
  pullReferenced(): Promise<void>;
  /**
   * Union of hashes referenced by every live document, via
   * `StoreDomain.blobHashes`; empty without one.
   */
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
}

export interface StoreEncryption {
  /**
   * Verifies, or writes on first encrypted use, the sealed sentinel in
   * `_config/encryption` so a wrong key fails fast. `Store.create` calls this
   * automatically; no-op without encryption. Under `onUndecryptable: 'hide'`
   * no key is wrong, so the sentinel is written but never verified.
   */
  verifyKey(): Promise<void>;
  /**
   * One-time sweep to enable encryption on an existing install: rewrites
   * every doc through the encrypting adapter. Idempotent. Follow with
   * `sync.push()` to convert the server's copies. `skipped` counts docs
   * sealed under other keys, which are left untouched; always 0 outside
   * `onUndecryptable: 'hide'`.
   */
  encryptLocal(): Promise<{ rewritten: number; skipped: number }>;
}
