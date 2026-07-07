import type { BaseDocument } from '../types';

/**
 * Build a `StoreDomain.blobHashes` extractor from a map of collection → the
 * top-level fields that hold blob hashes. Sugar for the common case where
 * references are flat string fields (e.g. `recipes.imageContentHash`): each
 * named field contributes its value when it's a non-empty string, so optional
 * and not-yet-set fields are skipped.
 *
 * ```ts
 * const domain = { blobHashes: blobFields({ recipes: ['imageContentHash'] }) };
 * ```
 *
 * For references nested in arrays or objects, or parsed out of a body, write
 * the `blobHashes` function directly instead.
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
