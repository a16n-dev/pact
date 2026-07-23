// The Store's namespaced runtime surface: one interface per namespace
// (`store.sync`, `store.author`, `store.backup`, `store.blobs`,
// `store.encryption`), plus the result types those methods speak. The
// document-access surface is `Collection` (collectionRef.ts); initialisation
// types are in `options.ts`.
import type { BlobAdapter } from '../blobs/blobAdapter';
import type { RegisterResult } from '../sync/sync';

/** `store.sync` — everything server-facing: pushing, pulling, registration. */
export interface StoreSync {
  /** Drain the push outbox, then push every doc in every synced collection. */
  push(): Promise<void>;
  /** Count of documents written locally but not yet accepted by the server. */
  pending(): Promise<number>;
  /**
   * Drop all locally-cached state except `_config` (credentials + author),
   * then re-pull every registered collection from a fresh cursor. Clears the
   * outbox — callers with unsynced writes that matter must `push()` first.
   * One-off recovery for when the server's docs were rewritten out-of-band.
   */
  resync(): Promise<void>;
  /** When this device last completed a pull covering all named collections. */
  lastSyncedAt(collections: string[]): Promise<Date | null>;
  /**
   * Trade the app's password for a long-lived access token bound to this
   * client. The clientId persists across calls, so re-registering (to rotate
   * a token, rename, or repoint) keeps the same server-side identity.
   */
  register(
    url: string,
    password: string,
    appName: string,
    clientName: string
  ): Promise<RegisterResult>;
  /** The persisted registration (token stripped), or null when unregistered. */
  registration(): Promise<ClientRegistration | null>;
  /**
   * Raw url + access token. Internal-use only — app surfaces should call
   * `registration()`, which strips the token. Exposed so helpers issuing
   * direct HTTP calls (e.g. the blob store) can authenticate.
   */
  credentials(): Promise<{ url: string; token: string } | null>;
  /** Forget the registration and close the connection. Local data is kept. */
  unregister(): Promise<void>;
}

/** What `sync.registration()` reports about the persisted registration. */
export interface ClientRegistration {
  id: string;
  name: string;
  url: string;
  /** null when the persisted config predates multi-tenancy. */
  appName: string | null;
}

/** `store.author` — who writes are attributed to. */
export interface StoreAuthor {
  /** The current author id (`LOCAL_AUTHOR_ID` until an identity is claimed). */
  get(): Promise<string>;
  /** Claim an identity: all subsequent writes are attributed to it. */
  set(authorId: string): Promise<void>;
  /**
   * Re-attribute every doc still carrying the local placeholder author to the
   * given id, bumping `updatedAt` so the next push picks them up. Run after
   * `set()` to adopt writes made before the identity existed.
   */
  reassignLocal(newAuthorId: string): Promise<void>;
  /** Soft-delete every live doc created by the given author. */
  wipe(authorId: string): Promise<void>;
}

/** `store.backup` — self-contained, server-independent snapshots. */
export interface StoreBackup {
  /**
   * Pack every document (tombstones included) into a portable archive,
   * bundling local blobs by default when a blob adapter is present. Internal
   * `_*` state never travels. The caller persists the bytes however it likes.
   */
  create(opts?: { blobs?: boolean }): Promise<Uint8Array>;
  /**
   * Load an archive produced by `create`. Docs are written raw (audit fields
   * and `schemaVersion` survive; reads migrate lazily) and reach a sync
   * server on the next `sync.push()`. `mode` defaults to `merge`
   * (last-write-wins, safe on a live store); see `RestoreMode`.
   */
  restore(archive: Uint8Array, opts?: { mode?: RestoreMode }): Promise<RestoreResult>;
}

/**
 * How `backup.restore` reconciles the archive against existing local data:
 * - `merge` (default): last-write-wins per document (the same strict
 *   `updatedAt` rule sync uses), so it's safe to run onto a live or
 *   partially-synced store. Blobs are content-addressed, so a backup blob is
 *   written only when its hash is missing locally.
 * - `replace`: clears every scope the archive carries (the document
 *   collections it contains, and all blobs if it carries any), then loads it
 *   verbatim. Internal `_*` state (credentials, cursors, outbox) is left
 *   untouched in both modes — the archive never contains it.
 */
export type RestoreMode = 'merge' | 'replace';

/** Summary of what a `backup.restore` call applied. */
export interface RestoreResult {
  mode: RestoreMode;
  /** Collections present in the archive. */
  collections: string[];
  /**
   * Archive collections this Store has no definition for — their docs were
   * not restored. Non-empty means the archive came from a domain with
   * collections this build doesn't know about.
   */
  collectionsSkipped: string[];
  /** Documents written to local storage. */
  docsWritten: number;
  /** Documents skipped because a newer local copy won (merge only). */
  docsSkipped: number;
  /** Blob bytes written locally. */
  blobsWritten: number;
  /** Blobs in the archive that couldn't be restored (store has no blob adapter). */
  blobsSkipped: number;
}

/** `store.blobs` — coordination between documents and the blob sidecar. */
export interface StoreBlobs {
  /** The raw blob backend, or null on doc-only stores. */
  readonly adapter: BlobAdapter | null;
  /**
   * Union of blob hashes referenced by every live document, via the domain's
   * `blobHashes` extractor (empty set when none is declared). Drives `prune`
   * and reference-driven pulls (`BlobStore.pullReferenced`).
   */
  referencedHashes(): Promise<Set<string>>;
  /**
   * Delete local blobs no live document references. Local-only: the server's
   * bucket is untouched (other devices may still reference a blob). Throws
   * without a `blobHashes` extractor; no-op without a blob adapter.
   */
  prune(): Promise<{ deleted: string[] }>;
  /**
   * Signal that the local blob set changed (capture, pull, delete). Routed
   * through the `change` channel (as `_blobs`) so UI invalidation can hang
   * off one subscription.
   */
  notifyChanged(): void;
}

/** `store.encryption` — at-rest/on-wire document encryption management. */
export interface StoreEncryption {
  /**
   * Fail fast on a wrong key: verify (or write, on first encrypted use) the
   * sealed sentinel in `_config/encryption`. No-op without encryption.
   * `Store.create` calls this automatically.
   */
  verifyKey(): Promise<void>;
  /**
   * One-time sweep for enabling encryption on an existing install: rewrite
   * every doc through the encrypting adapter. Follow with `sync.push()` to
   * convert the server's copies. Idempotent.
   */
  encryptLocal(): Promise<{ rewritten: number }>;
}
