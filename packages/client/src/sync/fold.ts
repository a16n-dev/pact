import type { BaseDocument } from '../types';

/**
 * What the fold needs from a server row: the document's identity, its
 * `updatedAt` (cleartext on the wire even for sealed envelopes), and which
 * client's row it is. Folding on these — before any decryption — means a
 * losing sibling sealed under a key this device doesn't hold can't wedge a
 * pull, and only winners get decrypted.
 */
export interface SiblingRow {
  id: string;
  collection: string;
  updatedAt: string;
  clientId?: string;
}

/**
 * One winning server row for a document as it leaves the sync client: the
 * decoded body plus the local collection name, which client's row it was and
 * the server write sequence it landed at.
 */
export interface PulledDocument<T extends BaseDocument = BaseDocument> {
  doc: T;
  collection: string;
  clientId?: string;
  seq?: number;
}

/**
 * Order on sibling rows of one document: later `updatedAt` wins; an exact
 * timestamp tie breaks on `clientId`. Every client folding the *same set* of
 * siblings lands on the same row. (A tie against a client's own local copy
 * is resolved separately, by the engine, in favour of the incoming row — so
 * exact-millisecond ties that straddle separate pulls can leave two clients
 * disagreeing until the document is next edited. Hybrid logical clocks will
 * close that gap; it's the whole client-side conflict rule for now.)
 */
export function compareSiblings(a: SiblingRow, b: SiblingRow): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  const ca = a.clientId ?? '';
  const cb = b.clientId ?? '';
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/**
 * Collapse rows to one winner per document (collection + id), preserving the
 * order in which documents first appeared.
 */
export function foldSiblings<R extends SiblingRow>(rows: readonly R[]): R[] {
  const winners = new Map<string, R>();
  for (const row of rows) {
    const key = `${row.collection}/${row.id}`;
    const current = winners.get(key);
    if (!current || compareSiblings(row, current) > 0) winners.set(key, row);
  }
  return [...winners.values()];
}
