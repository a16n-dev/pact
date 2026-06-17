import type { BaseDocument } from '../types';
import type { Migrator } from '../migrator';
import type { ParsedId } from '../collection';
import type { Store } from './store';

export interface StoreOptions {
  syncUrl?: string;
  syncToken?: string;
  realtime?: boolean;
  /**
   * When true, every `get`/`getMany`/`list` kicks off a background pull for
   * that collection (deduped per in-flight collection and throttled to
   * `READ_PULL_THROTTLE_MS`). A no-op without sync credentials.
   */
  pullOnRead?: boolean;
}

// Floor on how often a single collection re-pulls in response to reads. Reads
// fire on every render that touches a hook, so without this a busy screen
// would spray pulls; realtime + foreground sync cover the gaps in between.
export const READ_PULL_THROTTLE_MS = 10_000;

/**
 * Hooks injected by the consuming domain package. The Store treats stored
 * docs as opaque `BaseDocument`-shaped bags; this config tells it how to
 * validate writes, walk migrations, and enumerate known collections for
 * batch operations (pull-all, push-all). All fields are optional — when
 * omitted, the Store skips that step.
 */
export interface StoreDomain {
  /**
   * Validate (and stamp `schemaVersion` on) a doc before it's written.
   * Typically a Zod schema parse. Throws to reject the write.
   */
  validate?: (collection: string, doc: unknown) => unknown;
  /**
   * Migrator pre-bound to the domain's migration registry. Defaults to a
   * no-op (docs pass through unchanged, currentVersion always returns 1).
   */
  migrator?: Migrator;
  /**
   * Collections the Store iterates over for `pushAll` / pull-all-on-reconnect.
   * Omit to fall back to whatever the adapter currently has data for.
   */
  collections?: readonly string[];
  /**
   * Maps a document id back to its collection (by its prefix). Defaults to a
   * parser that knows nothing — always returns `null`.
   */
  parseId?: (id: string) => ParsedId | null;
  /**
   * Called from `setAuthor` after the current-author id is recorded, with
   * the Store and the new author id. The generic Store only tracks *who* the
   * current author is (in `_config/author`); domains that model the author as
   * an actual document use this hook to materialize that entity (e.g. create
   * a `users/<id>` doc). No-op when omitted.
   */
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
}

export type ClientConfigDoc = BaseDocument & {
  clientId: string;
  clientName: string;
  url: string;
  token: string;
};
export type AuthorConfigDoc = BaseDocument & { authorId: string };

export interface ClientRegistration {
  id: string;
  name: string;
  url: string;
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
