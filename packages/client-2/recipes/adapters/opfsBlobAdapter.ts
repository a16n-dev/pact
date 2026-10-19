import type { BlobAdapter } from '@a16n/pact-client';

/**
 * One file per blob in a directory of the origin private file system, with
 * the MIME type in a sibling `<hash>.type` file. `uriFor` hands out
 * `blob:` object URLs created on demand; call `revokeUris()` when a screen
 * unmounts to release them.
 */
export class OpfsBlobAdapter implements BlobAdapter {
  private readonly root: FileSystemDirectoryHandle;
  private readonly objectUrls = new Map<string, string>();

  private constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  static async open(directory = 'pact-blobs'): Promise<OpfsBlobAdapter> {
    const origin = await navigator.storage.getDirectory();
    return new OpfsBlobAdapter(await origin.getDirectoryHandle(directory, { create: true }));
  }

  private async fileHandle(name: string, create = false): Promise<FileSystemFileHandle | null> {
    try {
      return await this.root.getFileHandle(name, { create });
    } catch {
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    return (await this.fileHandle(hash)) !== null;
  }

  async read(hash: string): Promise<Uint8Array | null> {
    const handle = await this.fileHandle(hash);
    if (!handle) return null;
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async mimeType(hash: string): Promise<string | null> {
    const handle = await this.fileHandle(`${hash}.type`);
    return handle ? (await handle.getFile()).text() : null;
  }

  async write(hash: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    await this.writeFile(hash, bytes);
    await this.writeFile(`${hash}.type`, mimeType);
  }

  private async writeFile(name: string, content: Uint8Array | string): Promise<void> {
    const handle = await this.root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content as FileSystemWriteChunkType);
    await writable.close();
  }

  async delete(hash: string): Promise<void> {
    for (const name of [hash, `${hash}.type`]) {
      await this.root.removeEntry(name).catch(() => {});
    }
    const url = this.objectUrls.get(hash);
    if (url) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(hash);
    }
  }

  async list(): Promise<string[]> {
    const hashes: string[] = [];
    for await (const name of this.root.keys()) {
      if (!name.endsWith('.type')) hashes.push(name);
    }
    return hashes;
  }

  // Synchronous by contract, so the URL is only available once `prepareUri`
  // has read the file; render code calls that in an effect first.
  uriFor(hash: string): string | null {
    return this.objectUrls.get(hash) ?? null;
  }

  async prepareUri(hash: string): Promise<string | null> {
    const existing = this.objectUrls.get(hash);
    if (existing) return existing;
    const handle = await this.fileHandle(hash);
    if (!handle) return null;
    const url = URL.createObjectURL(await handle.getFile());
    this.objectUrls.set(hash, url);
    return url;
  }

  revokeUris(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }
}
