import type { BaseDocument } from './types';

export interface DatabaseAdapter {
  get<T extends BaseDocument>(collection: string, id: string): Promise<T | null>;
  getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]>;
  getAll<T extends BaseDocument>(collection: string): Promise<T[]>;
  put<T extends BaseDocument>(collection: string, doc: T): Promise<void>;
  /**
   * Optional batch write. Adapters whose backend can persist many docs in one
   * round trip (e.g. a D1 batch) implement this; callers fall back to
   * sequential `put` when absent.
   */
  putMany?<T extends BaseDocument>(collection: string, docs: T[]): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  wipe(): Promise<void>;
  listCollections(): Promise<string[]>;
}
