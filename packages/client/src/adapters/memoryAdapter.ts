import type { BaseDocument } from '../types';
import type { DatabaseAdapter } from './adapter';

export class InMemoryAdapter implements DatabaseAdapter {
  private data = new Map<string, Map<string, BaseDocument>>();

  private col(collection: string): Map<string, BaseDocument> {
    if (!this.data.has(collection)) this.data.set(collection, new Map());
    return this.data.get(collection)!;
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    return (this.col(collection).get(id) as T) ?? null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    const col = this.col(collection);
    return ids.map((id) => col.get(id)).filter((doc): doc is T => doc !== undefined) as T[];
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    return Array.from(this.col(collection).values()) as T[];
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    this.col(collection).set(doc.id, doc);
  }

  async delete(collection: string, id: string): Promise<void> {
    this.col(collection).delete(id);
  }

  async wipe(): Promise<void> {
    this.data.clear();
  }

  async listCollections(): Promise<string[]> {
    return Array.from(this.data.keys());
  }
}
