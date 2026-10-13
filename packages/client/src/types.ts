import { z } from 'zod';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * What a collection schema may output: `Json` plus `Date`. Documents are
 * persisted, synced, and archived as JSON, so `Map`, `Set`, `bigint`, and
 * class instances are excluded (a compile error at `defineCollection`).
 * `Date` is allowed only because the `date()` helper coerces the stored ISO
 * string back on read; a raw `z.date()` type-checks here but fails that read.
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
  // Per-collection version of the doc's shape; migrators upgrade older docs on read.
  schemaVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.string(),
  updatedBy: z.string(),
  // Tombstone. Nullable rather than optional: every record is known to be
  // either live (null) or soft-deleted at this time when it is written.
  deletedAt: z.iso.datetime().nullable(),
  deletedBy: z.string().nullable(),
});

export type BaseDocument = z.infer<typeof BaseDocumentSchema>;
