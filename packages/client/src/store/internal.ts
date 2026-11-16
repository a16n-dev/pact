import type { AdapterRecord, StoredRecord } from '../record';

export const CONFIG = '_config';
export const OUTBOX = '_outbox';
export const HELD = '_held';
export const TEXT_BASES = '_textBases';

/** Internal `_*` rows reuse the record shape with their payload in `fields` and no clocks. */
export function configRecord(id: string, value: Record<string, unknown>): StoredRecord {
  return { schemaVersion: 1, fields: { id, createdAt: '', ...value } };
}

export type NodeConfig = { node: string };

// Entries hold a reference only; the drain reads the record's current state
// at push time, from whichever lens queued it. `order` is the clock of the
// write that queued it. `key` is the storage key, absent on entries queued
// before lenses existed, which are all plain.
export type OutboxEntry = {
  collection: string;
  key?: string;
  docId: string;
  order: string;
};

// This device's text edits to one document that a compaction elsewhere may
// still have missed, in runs split at each push. `base` is the document before
// the run, sealed like the document, with every version of its text generation
// that arrived since merged in, so its text differs from the local text by
// just those edits; null when the run created the document. `start` is the
// clock of the run's first write and `seq` the push that sent it.
export type TextBaseRun = { base: AdapterRecord | null; start: string; seq?: number };

export type TextBases = { key: string; docId: string; runs: TextBaseRun[] };

export function outboxKey(collectionKey: string, docId: string): string {
  return `${collectionKey}/${docId}`;
}

export const MAX_DOCUMENT_BYTES = 1_000_000;
export const DEFAULT_TEXT_PUSH_DELAY_MS = 1_000;
