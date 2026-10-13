import type { BaseDocument } from '../types';

// Reads fire on every render that touches a hook, so without a floor a busy
// screen would spray pulls. Realtime and foreground sync cover the gaps.
export const READ_PULL_THROTTLE_MS = 10_000;

export type ClientConfigDoc = BaseDocument & {
  clientId: string;
  clientName: string;
  url: string;
  token: string;
  // Absent on config docs written before multi-tenancy; re-registration backfills it.
  appName?: string;
};

export type AuthorConfigDoc = BaseDocument & { authorId: string };

// Sealed sentinel written on first encrypted use and verified on every open,
// so a wrong key fails at startup instead of as scattered decrypt errors.
export type EncryptionCheckDoc = BaseDocument & { check: string };

export type SeedMarkerDoc = BaseDocument & { version: string };

// `cursor` is the server's seq high-water mark; `syncedAt` is this device's
// wall clock and only drives the "last synced" display.
export type SyncMetaDoc = BaseDocument & { cursor: number; syncedAt: string };

// Entries hold a reference only; the drain reads the doc's current version
// at push time. The `_` prefix keeps the outbox out of every sync path.
export const OUTBOX = '_outbox';
export type OutboxDoc = BaseDocument & { collection: string; docId: string };
export function outboxKey(collection: string, docId: string): string {
  return `${collection}/${docId}`;
}
