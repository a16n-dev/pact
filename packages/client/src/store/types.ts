// Internal bookkeeping shapes — the `_*` collection docs and sync plumbing.
// Nothing here is part of the public API: initialisation types live in
// `options.ts`, the namespaced runtime surface in `namespaces.ts`.
import type { BaseDocument } from '../types';

// Floor on how often a single collection re-pulls in response to reads. Reads
// fire on every render that touches a hook, so without this a busy screen
// would spray pulls; realtime + foreground sync cover the gaps in between.
export const READ_PULL_THROTTLE_MS = 10_000;

/** `_config/client`: the persisted registration (identity + credentials). */
export type ClientConfigDoc = BaseDocument & {
  clientId: string;
  clientName: string;
  url: string;
  token: string;
  // App this client registered under on a multi-tenant server. Absent on
  // config docs written before multi-tenancy; re-registration backfills it.
  appName?: string;
};

/** `_config/author`: the claimed author identity. */
export type AuthorConfigDoc = BaseDocument & { authorId: string };

/**
 * Local-only `_config/encryption` doc: a sealed sentinel written on first
 * encrypted use, verified on every subsequent open so a wrong key fails
 * loudly at startup instead of as scattered decrypt errors mid-read.
 */
export type EncryptionCheckDoc = BaseDocument & { check: string };

/** `_seeds/current`: which seed payload version has been applied. */
export type SeedMarkerDoc = BaseDocument & { version: string };

/** `_sync_meta/<collection>`: the pull cursor + last-synced wall clock. */
export type SyncMetaDoc = BaseDocument & { cursor: number; syncedAt: string };

// The internal, never-synced collection of pending document pushes. One entry
// per locally-written doc, keyed `${collection}/${docId}`, holding just a
// reference — the drain reads the doc's current version at push time. `_`-prefix
// keeps it out of every sync/pull/push-all path (those skip `_*` collections).
export const OUTBOX = '_outbox';
export type OutboxDoc = BaseDocument & { collection: string; docId: string };
export function outboxKey(collection: string, docId: string): string {
  return `${collection}/${docId}`;
}
