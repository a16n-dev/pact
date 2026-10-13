import type { BaseDocument } from '../types';

/**
 * One server row for a document as it arrives on pull: the document body
 * plus which client's row it is and the server write sequence it landed at.
 * `clientId` / `seq` are absent only when talking to a pre-sibling server,
 * which stores exactly one row per document.
 */
export interface PulledDocument<T extends BaseDocument = BaseDocument> {
  doc: T;
  /** Local collection name the row belongs to (an app-wide pull spans them all). */
  collection?: string;
  clientId?: string;
  seq?: number;
}

/**
 * Deterministic order on sibling rows of one document: later `updatedAt`
 * wins; an exact timestamp tie breaks on `clientId`, so every client folding
 * the same siblings — in any order — lands on the same row. This is the
 * whole client-side conflict rule for now (whole-document last-write-wins);
 * field-level merge slots in here later without touching the protocol.
 */
export function compareSiblings(a: PulledDocument, b: PulledDocument): number {
  if (a.doc.updatedAt !== b.doc.updatedAt) return a.doc.updatedAt < b.doc.updatedAt ? -1 : 1;
  const ca = a.clientId ?? '';
  const cb = b.clientId ?? '';
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/**
 * Collapse a pulled page to one winning row per document (collection + id),
 * preserving the order in which documents first appeared. Siblings of the same document arrive in
 * the same page or across pages; across pages the earlier winner is already
 * local by the time the later sibling is compared against it, so the result
 * is the same either way.
 */
export function foldSiblings<T extends BaseDocument>(
  rows: readonly PulledDocument<T>[]
): PulledDocument<T>[] {
  const winners = new Map<string, PulledDocument<T>>();
  for (const row of rows) {
    const key = `${row.collection ?? ''}/${row.doc.id}`;
    const current = winners.get(key);
    if (!current || compareSiblings(row, current) > 0) winners.set(key, row);
  }
  return [...winners.values()];
}
