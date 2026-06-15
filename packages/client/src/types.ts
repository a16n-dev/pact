import { z } from 'zod';

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
