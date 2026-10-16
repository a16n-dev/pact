import type { AdapterRecord, StoredEntry } from '../record';

/**
 * Keyed by `(collection, id)`; the value is JSON the adapter never has to
 * read. Internal `_*` collections go through the same methods.
 */
export type DatabaseAdapter = {
  get(collection: string, id: string): Promise<AdapterRecord | null>;
  /** Missing ids are omitted; order is unspecified. */
  getMany(collection: string, ids: readonly string[]): Promise<StoredEntry[]>;
  getAll(collection: string): Promise<StoredEntry[]>;
  put(collection: string, id: string, record: AdapterRecord): Promise<void>;
  /** Callers fall back to sequential `put` when this is absent. */
  putMany?(collection: string, entries: readonly StoredEntry[]): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  wipe(): Promise<void>;
  listCollections(): Promise<string[]>;
};
