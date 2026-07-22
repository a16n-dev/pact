import type { BaseDocument } from '../types';
import type { CollectionDefinition } from '../collection';
import type { Store } from './store';
import type { DocCipher } from '../crypto/types';

// Sync credentials handed to the Store constructor. Internal plumbing —
// `Store.create` populates it from the persisted client doc; callers configure
// sync via `registerClient`, not by passing this directly.
export interface StoreSyncConfig {
  syncUrl?: string;
  syncToken?: string;
}

// Floor on how often a single collection re-pulls in response to reads. Reads
// fire on every render that touches a hook, so without this a busy screen
// would spray pulls; realtime + foreground sync cover the gaps in between.
export const READ_PULL_THROTTLE_MS = 10_000;

/**
 * The consuming domain's configuration for a Store. Its heart is
 * `collections`: the schemas provided here *define* which collections exist.
 * The Store derives everything schema-adjacent from them — write validation
 * (each collection's Zod schema), the migrator (each collection's migration
 * chain), id parsing (each collection's id prefix), and the sync enumeration
 * (`synced` collections) — and rejects reads and writes against any
 * collection that isn't defined. Only internal `_*` collections live outside
 * the definition list.
 */
export interface StoreDomain<
  Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[],
> {
  /**
   * The collections this Store serves, each defined via `defineCollection`.
   * Required — a collection with no definition (and therefore no schema)
   * does not exist as far as the Store is concerned.
   */
  collections: Defs;
  /**
   * Called from `setAuthor` after the current-author id is recorded, with
   * the Store and the new author id. The generic Store only tracks *who* the
   * current author is (in `_config/author`); domains that model the author as
   * an actual document use this hook to materialize that entity (e.g. create
   * a `users/<id>` doc). No-op when omitted.
   */
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
  /**
   * Blob hashes a document references. The Store unions these across all
   * *live* documents to power blob garbage collection (`pruneBlobs`) and
   * reference-driven pull (`BlobStore.pullReferenced`). Omit for domains with
   * no blobs — `pruneBlobs` then refuses to run rather than treat every blob
   * as an orphan. For the common case of flat top-level hash fields, build
   * this with the `blobFields` helper; write it by hand when references are
   * nested, in arrays, or parsed out of a body.
   */
  blobHashes?: (collection: string, doc: BaseDocument) => Iterable<string>;
  /**
   * Optional end-to-end document encryption. When set, domain fields are
   * sealed into one ciphertext string both at rest (the adapter only ever
   * stores ciphertext; docs are decrypted as they're read into memory) and
   * on the sync wire — the server sees base sync fields plus the envelope.
   * All clients of the app (including an agent's MCP Worker) must hold the
   * same key. Internal `_*` collections and blob bytes are not encrypted.
   */
  encryption?: { cipher: DocCipher };
}

export type ClientConfigDoc = BaseDocument & {
  clientId: string;
  clientName: string;
  url: string;
  token: string;
  // App this client registered under on a multi-tenant server. Absent on
  // config docs written before multi-tenancy; re-registration backfills it.
  appName?: string;
};
export type AuthorConfigDoc = BaseDocument & { authorId: string };

/**
 * Local-only `_config/encryption` doc: a sealed sentinel written on first
 * encrypted use, verified on every subsequent open so a wrong key fails
 * loudly at startup instead of as scattered decrypt errors mid-read.
 */
export type EncryptionCheckDoc = BaseDocument & { check: string };

export interface ClientRegistration {
  id: string;
  name: string;
  url: string;
  /** null when the persisted config predates multi-tenancy. */
  appName: string | null;
}

export type ChangeHandler = (collection: string) => void;

/**
 * A versioned set of seed documents for `Store.seed`. `docs` entries carry the
 * document content (sans audit fields) plus its id; the Store stamps audit
 * fields and validates on write. `version` identifies the payload — seeding is
 * skipped entirely while the stored marker matches it, so derive it from the
 * seed content (e.g. a hash) or bump it manually on every seed change.
 */
export interface SeedSet {
  version: string;
  docs: ReadonlyMap<string, ReadonlyArray<{ id: string } & Record<string, unknown>>>;
}

export type SeedMarkerDoc = BaseDocument & { version: string };

export type SyncMetaDoc = BaseDocument & { cursor: number; syncedAt: string };

/**
 * How `restoreBackup` reconciles the archive against existing local data:
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

/** Summary of what a `restoreBackup` call applied. */
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

// The internal, never-synced collection of pending document pushes. One entry
// per locally-written doc, keyed `${collection}/${docId}`, holding just a
// reference — the drain reads the doc's current version at push time. `_`-prefix
// keeps it out of every sync/pull/push-all path (those skip `_*` collections).
export const OUTBOX = '_outbox';
export type OutboxDoc = BaseDocument & { collection: string; docId: string };
export function outboxKey(collection: string, docId: string): string {
  return `${collection}/${docId}`;
}
