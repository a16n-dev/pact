import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client-1';

type FileShape = Record<string, Record<string, BaseDocument>>;

export class JsonFileAdapter implements DatabaseAdapter {
  private data: FileShape | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // The file is read once and cached, so a second process writing the same
  // file is not seen. Single-process use only.
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

  // Write to a temp file and rename so a crash mid-write cannot truncate the data file.
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
    await this.save();
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
