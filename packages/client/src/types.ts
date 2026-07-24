import { z } from 'zod';

/** A value representable directly in JSON — what actually survives storage and sync. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * The set of value types a collection schema may *output*. It's `Json` plus
 * `Date`, because documents are persisted, synced, and archived as JSON: the
 * schema's parse output is what the adapter stores and what re-parses on read.
 * A `Map`/`Set`/`bigint`/class-instance output can't round-trip through that
 * pipeline, so it's excluded here (a compile error at `defineCollection`).
 *
 * `Date` is allowed only because the store re-validates on read and the `date()`
 * helper coerces — the persisted ISO string re-parses back to a `Date` on every
 * adapter. A raw `z.date()` (no coercion) type-checks against this but throws on
 * read once its value has been serialized; use `date()` instead.
 */
export type Storable =
  | string
  | number
  | boolean
  | null
  | Date
  | Storable[]
  | { [key: string]: Storable | undefined };

export const BaseDocumentSchema = z.object({
  id: z.string(),
  // Per-collection schema version of this doc's shape. Migrators upgrade
  // older shapes on read; new writes are stamped with the current version
  // for the collection.
  schemaVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.string(),
  updatedBy: z.string(),
  // Tombstones: null = live (the record exists and isn't deleted),
  // ISO string = soft-deleted at this time. Always known at write time, so
  // nullable rather than optional — every record is either alive or deleted.
  deletedAt: z.iso.datetime().nullable(),
  deletedBy: z.string().nullable(),
});

export type BaseDocument = z.infer<typeof BaseDocumentSchema>;
