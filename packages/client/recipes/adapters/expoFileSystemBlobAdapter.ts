import type { BlobAdapter } from '@a16n/pact-client';

// Declared structurally so this file typechecks without `expo-file-system`
// installed. In an app, delete this and import `Directory` and `File` from
// 'expo-file-system' (SDK 52+).
export type ExpoDirectory = {
  uri: string;
  exists: boolean;
  create(): void;
  list(): Array<{ name: string; uri: string }>;
};
export type ExpoFile = {
  uri: string;
  exists: boolean;
  write(bytes: Uint8Array | string): void;
  bytes(): Uint8Array;
  text(): string;
  delete(): void;
};
export type ExpoFileSystem = {
  directory(uri: string): ExpoDirectory;
  file(uri: string): ExpoFile;
};

/**
 * One file per blob under `<root>/<hash>`, with the MIME type alongside in
 * `<root>/<hash>.type`. `uriFor` returns the `file://` URI an `<Image>` can
 * render directly.
 */
export class ExpoFileSystemBlobAdapter implements BlobAdapter {
  private readonly fs: ExpoFileSystem;
  private readonly root: ExpoDirectory;

  constructor(fs: ExpoFileSystem, rootUri: string) {
    this.fs = fs;
    this.root = fs.directory(rootUri);
    if (!this.root.exists) this.root.create();
  }

  private file(hash: string): ExpoFile {
    return this.fs.file(`${this.root.uri}/${hash}`);
  }

  private typeFile(hash: string): ExpoFile {
    return this.fs.file(`${this.root.uri}/${hash}.type`);
  }

  async has(hash: string): Promise<boolean> {
    return this.file(hash).exists;
  }

  async read(hash: string): Promise<Uint8Array | null> {
    const file = this.file(hash);
    return file.exists ? file.bytes() : null;
  }

  async mimeType(hash: string): Promise<string | null> {
    const file = this.typeFile(hash);
    return file.exists ? file.text() : null;
  }

  async write(hash: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    this.file(hash).write(bytes);
    this.typeFile(hash).write(mimeType);
  }

  async delete(hash: string): Promise<void> {
    for (const file of [this.file(hash), this.typeFile(hash)]) {
      if (file.exists) file.delete();
    }
  }

  async list(): Promise<string[]> {
    return this.root
      .list()
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith('.type'));
  }

  uriFor(hash: string): string | null {
    const file = this.file(hash);
    return file.exists ? file.uri : null;
  }
}
