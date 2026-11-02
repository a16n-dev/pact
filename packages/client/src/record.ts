import { z } from 'zod';
import { clockToIso, compareClocks, maxClock } from './clock';
import { deepEqual } from './lib/deepEqual';
import type { MergeMode } from './collection';

/**
 * What a `DatabaseAdapter` holds per `(collection, id)` and what travels as
 * `data` on the wire. `fields` carries `id`, `createdAt`, `deletedAt` and the
 * plain schema fields; text fields live in `text` as one Yjs document.
 */
export type StoredRecord = {
  schemaVersion: number;
  fields: Record<string, unknown>;
  /** Encoded clock per field, in field-level collections. */
  clocks?: Record<string, string>;
  /** The record's one encoded clock, in document-level collections. */
  clock?: string;
  /** Base64 Yjs state, present only when the collection has text fields. */
  text?: string;
};

/** A record sealed by the store's cipher, as stored at rest and sent on the wire. */
export type SealedRecord = {
  enc: string;
  hlc: string;
};

export type AdapterRecord = StoredRecord | SealedRecord;

export type StoredEntry = { id: string; record: AdapterRecord };

export function isSealedRecord(record: AdapterRecord): record is SealedRecord {
  return typeof (record as SealedRecord).enc === 'string';
}

export const StoredRecordSchema = z.object({
  schemaVersion: z.number().int().positive(),
  fields: z.object({ id: z.string(), createdAt: z.string() }).loose(),
  clocks: z.record(z.string(), z.string()).optional(),
  clock: z.string().optional(),
  text: z.string().optional(),
});

export function greatestClock(record: StoredRecord): string | undefined {
  if (record.clock !== undefined) return record.clock;
  let greatest: string | undefined;
  for (const clock of Object.values(record.clocks ?? {})) greatest = maxClock(greatest, clock);
  return greatest;
}

export function updatedAtOf(record: StoredRecord): string {
  const clock = greatestClock(record);
  return clock !== undefined ? clockToIso(clock) : (record.fields.createdAt as string);
}

export type TextMerge = (
  local: string | undefined,
  incoming: string | undefined
) => string | undefined;

export type MergeResult = { record: StoredRecord; changed: boolean };

function earlierCreatedAt(local: StoredRecord, incoming: StoredRecord): string {
  const a = local.fields.createdAt as string;
  const b = incoming.fields.createdAt as string;
  return a <= b ? a : b;
}

/**
 * Commutative and idempotent, so the order versions arrive in never matters.
 * Both records must already be at the same schema version. `mergeText`
 * combines the two Yjs states and is required when either side has text.
 */
export function mergeRecords(
  local: StoredRecord,
  incoming: StoredRecord,
  mode: MergeMode,
  mergeText?: TextMerge
): MergeResult {
  const merged =
    mode === 'document' ? mergeByDocument(local, incoming) : mergeByField(local, incoming);
  if (local.text !== undefined || incoming.text !== undefined) {
    if (!mergeText) throw new Error('Merging records with text fields needs a text merge');
    merged.text = mergeText(local.text, incoming.text);
  }
  merged.schemaVersion = Math.max(local.schemaVersion, incoming.schemaVersion);
  merged.fields.createdAt = earlierCreatedAt(local, incoming);
  return { record: merged, changed: !deepEqual(merged, local) };
}

function mergeByDocument(local: StoredRecord, incoming: StoredRecord): StoredRecord {
  if (local.clock === undefined || incoming.clock === undefined) {
    throw new Error('Document-level merge needs a clock on both records');
  }
  const winner = compareClocks(incoming.clock, local.clock) > 0 ? incoming : local;
  return { schemaVersion: winner.schemaVersion, fields: { ...winner.fields }, clock: winner.clock };
}

function mergeByField(local: StoredRecord, incoming: StoredRecord): StoredRecord {
  const localClocks = local.clocks ?? {};
  const incomingClocks = incoming.clocks ?? {};
  const fields: Record<string, unknown> = { ...local.fields };
  const clocks: Record<string, string> = { ...localClocks };
  for (const [name, clock] of Object.entries(incomingClocks)) {
    const mine = localClocks[name];
    if (mine !== undefined && compareClocks(mine, clock) >= 0) continue;
    clocks[name] = clock;
    if (name in incoming.fields) fields[name] = incoming.fields[name];
    else delete fields[name];
  }
  // Clockless fields (`id`, `createdAt`) come from whichever side has them.
  for (const [name, value] of Object.entries(incoming.fields)) {
    if (!(name in fields) && !(name in clocks)) fields[name] = value;
  }
  return { schemaVersion: local.schemaVersion, fields, clocks };
}
