import type { BaseDocument } from '../types';

/**
 * Builds a `StoreDomain.blobHashes` extractor for the common case where blob
 * references are flat string fields, e.g. `{ recipes: ['imageContentHash'] }`.
 * Empty or unset fields are skipped. References nested in arrays or objects
 * need a hand-written `blobHashes` instead.
 */
export function blobFields(
  map: Record<string, readonly string[]>
): (collection: string, doc: BaseDocument) => Iterable<string> {
  return function* (collection, doc) {
    const fields = map[collection];
    if (!fields) return;
    const record = doc as unknown as Record<string, unknown>;
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string' && value.length > 0) yield value;
    }
  };
}
