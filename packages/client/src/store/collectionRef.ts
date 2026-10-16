import type { BaseDocument } from '../types';
import type { IndexKeyInput } from './indexes';

/**
 * Obtained via `store.collection(name)`. The document type and `IndexNames`
 * are inferred from that collection's definition; `IndexNames` is `string`
 * when the collection is not statically known.
 */
export interface Collection<T extends BaseDocument, IndexNames extends string = string> {
  /**
   * Soft-deleted docs read as null unless `includeDeleted` is set; then
   * inspect `deletedAt` to tell a tombstone from a live doc.
   */
  get(id: string, opts?: { includeDeleted?: boolean }): Promise<T | null>;
  /** In input order, minus any missing or soft-deleted. */
  getMany(ids: string[]): Promise<T[]>;
  /** Live docs only unless `includeDeleted` is set. */
  list(opts?: { includeDeleted?: boolean }): Promise<T[]>;
  /**
   * Live docs whose extractor emitted `key`. Equality only; order is
   * unspecified. Matches are re-read through the store, so results are
   * migrated, validated, and tombstone-free even if the index momentarily
   * lags a write. Throws on an unknown index name.
   */
  listByIndex(index: IndexNames, key: IndexKeyInput): Promise<T[]>;
  /** The id is generated (prefix + random) unless supplied. */
  create(input: Omit<T, keyof BaseDocument> & { id?: T['id'] }): Promise<T>;
  createMany(items: Array<Omit<T, keyof BaseDocument> & { id?: T['id'] }>): Promise<T[]>;
  /**
   * Attributed to the system author and never queued for push, for locally
   * materialised reference data. See `store.seed` for the versioned bulk form.
   */
  createAsSystem(input: Omit<T, keyof BaseDocument> & { id?: T['id'] }): Promise<T>;
  /** Throws when the doc does not exist. */
  update(id: string, input: Partial<Omit<T, keyof BaseDocument>>): Promise<T>;
  updateMany(updates: Array<{ id: string } & Partial<Omit<T, keyof BaseDocument>>>): Promise<T[]>;
  /** A soft-deleted doc counts as absent: upserting its id revives it as a fresh doc. */
  upsert(input: Omit<T, keyof BaseDocument> & { id: T['id'] }): Promise<T>;
  /** Soft-delete; the tombstone remains and syncs so other devices converge. */
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
  /**
   * Removes the doc locally with no tombstone and no sync push, so a copy
   * still on the server re-pulls on the next sync. Prefer `delete`.
   */
  hardDelete(id: string): Promise<void>;
  hardDeleteMany(ids: string[]): Promise<void>;
  /** Fetches one doc from the server and merges it in, last-write-wins. */
  pull(id: string): Promise<T | null>;
  /** Fetches every remote change for the collection and merges it in. */
  pullAll(): Promise<T[]>;
}
