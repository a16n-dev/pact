import { z } from 'zod';
import type { CollectionDefinition } from '../collection';
import type { Migrator } from '../migrator';
import { greatestClock, updatedAtOf, type StoredRecord } from '../record';
import type { AnyDocument } from '../types';
import type { TextDocument } from '../text/engine';

export function needsMigration(
  migrator: Migrator,
  def: CollectionDefinition,
  record: StoredRecord
): boolean {
  return record.schemaVersion < migrator.currentVersion(def.name);
}

/**
 * A field present before and after keeps its clock; one the migration
 * produced takes the record's greatest clock so it outranks nothing it did
 * not derive from. Document-level records keep their one clock.
 */
export function migrateRecord(
  migrator: Migrator,
  def: CollectionDefinition,
  record: StoredRecord
): StoredRecord {
  // Canonical JSON, so a migration that sets a field to `undefined` drops it
  // and any `Date` it produces lands as the ISO string a write would store.
  const fields = JSON.parse(
    JSON.stringify(migrator.migrate(def.name, record.schemaVersion, record.fields))
  ) as Record<string, unknown>;
  const out: StoredRecord = {
    schemaVersion: migrator.currentVersion(def.name),
    fields,
  };
  if (record.text !== undefined) out.text = record.text;
  if (def.merge !== 'field') {
    out.clock = record.clock;
    return out;
  }
  const previous = record.clocks ?? {};
  const fallback = greatestClock(record);
  const clocks: Record<string, string> = {};
  for (const name of Object.keys(fields)) {
    if (name === 'id' || name === 'createdAt') continue;
    const kept = previous[name];
    if (kept !== undefined) clocks[name] = kept;
    else if (fallback !== undefined) clocks[name] = fallback;
  }
  for (const name of def.textFields) {
    const kept = previous[name];
    if (kept !== undefined) clocks[name] = kept;
  }
  out.clocks = clocks;
  return out;
}

/** The typed document as apps see it, before schema validation. */
export function projectRecord(
  def: CollectionDefinition,
  record: StoredRecord,
  text: TextDocument | null
): AnyDocument {
  const doc: Record<string, unknown> = { ...record.fields, updatedAt: updatedAtOf(record) };
  for (const field of def.textFields) doc[field] = text ? text.toString(field) : '';
  return doc as AnyDocument;
}

/** Null when the record does not satisfy the collection schema. */
export function validateProjection(
  def: CollectionDefinition,
  doc: AnyDocument
): AnyDocument | null {
  const result = def.schema.safeParse(doc);
  return result.success ? (result.data as AnyDocument) : null;
}

export function parseProjection(def: CollectionDefinition, doc: AnyDocument): AnyDocument {
  return def.schema.parse(doc) as AnyDocument;
}

export function isZodError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError;
}
