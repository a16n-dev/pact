import type { BaseDocument } from '../types';
import type { IndexKeyInput } from './indexes';

/**
 * A typed handle to one defined collection — the only way to read and write
 * documents. Obtain one via `store.collection(name)`; the document type is
 * inferred from that collection's schema, and `IndexNames` from its declared
 * indexes (`string` when the collection isn't statically known).
 */
export interface Collection<T extends BaseDocument, IndexNames extends string = string> {
  /**
   * One doc by id, or null when missing. Soft-deleted docs read as null
   * unless `includeDeleted` is set — with it, inspect `deletedAt` to tell a
   * tombstone from a live doc.
   */
  get(id: string, opts?: { includeDeleted?: boolean }): Promise<T | null>;
  /** The named docs, in input order, minus any missing or soft-deleted. */
  getMany(ids: string[]): Promise<T[]>;
  /**
   * All live docs. Pass `includeDeleted` to keep tombstones in the result
   * (inspect `deletedAt` to tell them apart) — for debug/admin surfaces.
   */
  list(opts?: { includeDeleted?: boolean }): Promise<T[]>;
  /**
   * Live docs found under `key` in the named secondary index — the docs whose
   * extractor (declared in `defineCollection`'s `indexes`) emitted `key`.
   * Equality/membership only; order is unspecified. Reads the matched docs
   * through the store, so results are migrated, validated, and tombstone-free
   * even if the index momentarily lags a write. Throws on an unknown index name.
   */
  listByIndex(index: IndexNames, key: IndexKeyInput): Promise<T[]>;
  /** Create a doc. The id is generated (prefix + random) unless supplied. */
  create(input: Omit<T, keyof BaseDocument> & { id?: T['id'] }): Promise<T>;
  /** Batch form of `create`. */
  createMany(items: Array<Omit<T, keyof BaseDocument> & { id?: T['id'] }>): Promise<T[]>;
  /**
   * Like `create`, but attributed to the system author and never queued for
   * push — for locally-materialized reference data (see `store.seed` for the
   * versioned bulk form).
   */
  createAsSystem(input: Omit<T, keyof BaseDocument> & { id?: T['id'] }): Promise<T>;
  /** Merge partial fields into the doc. Throws when the doc doesn't exist. */
  update(id: string, input: Partial<Omit<T, keyof BaseDocument>>): Promise<T>;
  /** Batch form of `update`. */
  updateMany(updates: Array<{ id: string } & Partial<Omit<T, keyof BaseDocument>>>): Promise<T[]>;
  /**
   * Create the doc if absent, update it if present — `id` is required since
   * it's the match key. A soft-deleted doc counts as absent: upserting its id
   * revives it as a fresh doc.
   */
  upsert(input: Omit<T, keyof BaseDocument> & { id: T['id'] }): Promise<T>;
  /** Soft-delete: the tombstone remains (and syncs) so other devices converge. */
  delete(id: string): Promise<void>;
  /** Batch form of `delete`. */
  deleteMany(ids: string[]): Promise<void>;
  /**
   * Remove the doc from local storage outright — no tombstone, no sync push.
   * Low-level/debug use; normal deletes should go through `delete` so the
   * tombstone propagates. A doc still on the server re-pulls on next sync.
   */
  hardDelete(id: string): Promise<void>;
  /** Batch form of `hardDelete`. */
  hardDeleteMany(ids: string[]): Promise<void>;
  /** Fetch one doc fresh from the server and merge it in (last-write-wins). */
  pull(id: string): Promise<T | null>;
  /** Fetch every remote change for the collection and merge it in. */
  pullAll(): Promise<T[]>;
}
