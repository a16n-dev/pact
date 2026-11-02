import type { StoredRecord } from '../record';

export const CONFIG = '_config';
export const OUTBOX = '_outbox';
export const HELD = '_held';

/** Internal `_*` rows reuse the record shape with their payload in `fields` and no clocks. */
export function configRecord(id: string, value: Record<string, unknown>): StoredRecord {
  return { schemaVersion: 1, fields: { id, createdAt: '', ...value } };
}

export type NodeConfig = { node: string };

// Entries hold a reference only; the drain reads the record's current state
// at push time, from whichever lens queued it. `order` is the clock of the
// write that queued it. `key` is the storage key, absent on entries queued
// before lenses existed, which are all plain.
export type OutboxEntry = { collection: string; key?: string; docId: string; order: string };

export function outboxKey(collectionKey: string, docId: string): string {
  return `${collectionKey}/${docId}`;
}

export const MAX_DOCUMENT_BYTES = 1_000_000;
export const TEXT_PUSH_DEBOUNCE_MS = 1_000;
