import type { AdapterRecord, StoredEntry } from '../record';
import type { DatabaseAdapter } from './adapter';

export class InMemoryAdapter implements DatabaseAdapter {
  private data = new Map<string, Map<string, AdapterRecord>>();

  private col(collection: string): Map<string, AdapterRecord> {
    let col = this.data.get(collection);
    if (!col) {
      col = new Map();
      this.data.set(collection, col);
    }
    return col;
  }

  async get(collection: string, id: string): Promise<AdapterRecord | null> {
    return this.col(collection).get(id) ?? null;
  }

  async getMany(collection: string, ids: readonly string[]): Promise<StoredEntry[]> {
    const col = this.col(collection);
    const out: StoredEntry[] = [];
    for (const id of ids) {
      const record = col.get(id);
      if (record) out.push({ id, record });
    }
    return out;
  }

  async getAll(collection: string): Promise<StoredEntry[]> {
    return Array.from(this.col(collection), ([id, record]) => ({ id, record }));
  }

  // Cloned so the store's later mutations never reach the stored copy, as
  // with any adapter that serialises.
  async put(collection: string, id: string, record: AdapterRecord): Promise<void> {
    this.col(collection).set(id, structuredClone(record));
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
