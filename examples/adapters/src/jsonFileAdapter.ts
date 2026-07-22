import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client';

type FileShape = Record<string, Record<string, BaseDocument>>;

/**
 * `DatabaseAdapter` backed by a single JSON file — for Node CLIs, scripts,
 * and small tools where "the database" being a human-readable file you can
 * `cat` is a feature. Loads the whole file into memory on first access and
 * rewrites it after every mutation (atomically: temp file + rename), so it's
 * for small datasets and a single process; use the `node:sqlite` recipe when
 * either stops being true.
 */
export class JsonFileAdapter implements DatabaseAdapter {
  private data: FileShape | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load(): Promise<FileShape> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await readFile(this.filePath, 'utf8')) as FileShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.data = {};
    }
    return this.data;
  }

  private async save(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2));
    await rename(tmpPath, this.filePath);
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const data = await this.load();
    return (data[collection]?.[id] as T) ?? null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    const data = await this.load();
    return ids
      .map((id) => data[collection]?.[id])
      .filter((doc): doc is BaseDocument => doc !== undefined) as T[];
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    const data = await this.load();
    return Object.values(data[collection] ?? {}) as T[];
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    const data = await this.load();
    (data[collection] ??= {})[doc.id] = doc;
    await this.save();
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    const data = await this.load();
    const col = (data[collection] ??= {});
    for (const doc of docs) col[doc.id] = doc;
    await this.save(); // one rewrite for the whole batch
  }

  async delete(collection: string, id: string): Promise<void> {
    const data = await this.load();
    if (!data[collection]?.[id]) return;
    delete data[collection][id];
    if (Object.keys(data[collection]).length === 0) delete data[collection];
    await this.save();
  }

  async wipe(): Promise<void> {
    this.data = {};
    await rm(this.filePath, { force: true });
  }

  async listCollections(): Promise<string[]> {
    return Object.keys(await this.load());
  }
}
