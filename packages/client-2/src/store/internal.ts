import type { StoredRecord } from '../record';

export const CONFIG = '_config';
export const OUTBOX = '_outbox';
export const HELD = '_held';

/** Internal `_*` rows reuse the record shape with their payload in `fields` and no clocks. */
export function configRecord(id: string, value: Record<string, unknown>): StoredRecord {
  return { schemaVersion: 1, fields: { id, createdAt: '', ...value } };
}

export type NodeConfig = { node: string };

// Sealed sentinel written on first encrypted use and verified on every open,
// so a wrong key fails at startup instead of as scattered decrypt errors.
export type EncryptionConfig = { check: string };

// Entries hold a reference only; the drain reads the record's current state
// at push time. `order` is the clock of the write that queued it.
export type OutboxEntry = { collection: string; docId: string; order: string };

export function outboxKey(collectionKey: string, docId: string): string {
  return `${collectionKey}/${docId}`;
}

export const MAX_DOCUMENT_BYTES = 1_000_000;
export const TEXT_PUSH_DEBOUNCE_MS = 1_000;
