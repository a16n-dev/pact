import type { BaseDocument } from '../types';
import type { Store } from './store';

/**
 * A typed handle to one collection, bound to its parent `Store`. Every method
 * forwards to the Store with the collection name pre-applied — sugar over
 * calling `store.get('recipes', id)` directly. Obtain one via `store.collection`.
 */
export class Collection<T extends BaseDocument> {
  private readonly store: Store;
  private readonly name: string;

  constructor(store: Store, name: string) {
    this.store = store;
    this.name = name;
  }

  get(id: string): Promise<T | null> {
    return this.store.get<T>(this.name, id);
  }
  getMany(ids: string[]): Promise<T[]> {
    return this.store.getMany<T>(this.name, ids);
  }
  list(): Promise<T[]> {
    return this.store.list<T>(this.name);
  }
  create(id: string, input: Omit<T, keyof BaseDocument>): Promise<T> {
    return this.store.create<T>(this.name, id, input);
  }
  update(id: string, input: Partial<Omit<T, keyof BaseDocument>>): Promise<T> {
    return this.store.update<T>(this.name, id, input);
  }
  delete(id: string): Promise<void> {
    return this.store.delete(this.name, id);
  }
  createMany(items: Array<{ id: string } & Omit<T, keyof BaseDocument>>): Promise<T[]> {
    return this.store.createMany<T>(this.name, items);
  }
  updateMany(updates: Array<{ id: string } & Partial<Omit<T, keyof BaseDocument>>>): Promise<T[]> {
    return this.store.updateMany<T>(this.name, updates);
  }
  deleteMany(ids: string[]): Promise<void> {
    return this.store.deleteMany(this.name, ids);
  }
  pull(): Promise<T[]> {
    return this.store.pull<T>(this.name);
  }
  pullDocument(id: string): Promise<T | null> {
    return this.store.pullDocument<T>(this.name, id);
  }
}
