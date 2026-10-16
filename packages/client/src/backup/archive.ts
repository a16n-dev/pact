import type { BaseDocument } from '../types';

/** Bumped only on a breaking change to the container layout. */
export const BACKUP_FORMAT_VERSION = 1;

// ASCII "PBK1"
const MAGIC = Uint8Array.from([0x50, 0x42, 0x4b, 0x31]);

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  /**
   * Keyed by collection name (the portable identity, not the storage key),
   * tombstones included. Internal `_*` collections are deliberately absent:
   * credentials, cursors and the outbox are device-specific.
   */
  collections: Record<string, BaseDocument[]>;
}

export interface BackupBlob {
  hash: string;
  mimeType: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  raw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u32(value: number): void {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value, true);
    this.raw(buf);
  }

  lenBytes(bytes: Uint8Array): void {
    this.u32(bytes.length);
    this.raw(bytes);
  }

  str(value: string): void {
    this.lenBytes(encoder.encode(value));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

class ByteReader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  private require(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new Error('Corrupt backup: unexpected end of data');
    }
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  lenBytes(): Uint8Array {
    const len = this.u32();
    this.require(len);
    // slice copies, so a returned blob doesn't pin the whole archive buffer
    const slice = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  str(): string {
    return decoder.decode(this.lenBytes());
  }

  matchMagic(expected: Uint8Array): boolean {
    this.require(expected.length);
    for (let i = 0; i < expected.length; i++) {
      if (this.bytes[this.offset + i] !== expected[i]) return false;
    }
    this.offset += expected.length;
    return true;
  }
}

/**
 * Produces a single length-prefixed binary container: magic, JSON manifest,
 * then each blob's raw bytes. Blobs stay binary rather than base64 inside the
 * manifest so large payloads don't pay the ~33% size tax. Callers persist the
 * result wherever they like; no filesystem assumption is made.
 */
export function packBackup(manifest: BackupManifest, blobs: readonly BackupBlob[]): Uint8Array {
  const writer = new ByteWriter();
  writer.raw(MAGIC);
  writer.str(JSON.stringify(manifest));
  writer.u32(blobs.length);
  for (const blob of blobs) {
    writer.str(blob.hash);
    writer.str(blob.mimeType);
    writer.lenBytes(blob.bytes);
  }
  return writer.finish();
}

/** Throws on a foreign archive, a truncated one, or an unsupported version. */
export function unpackBackup(archive: Uint8Array): {
  manifest: BackupManifest;
  blobs: BackupBlob[];
} {
  const reader = new ByteReader(archive);
  if (!reader.matchMagic(MAGIC)) {
    throw new Error('Not a pact backup (bad magic bytes)');
  }
  const manifest = JSON.parse(reader.str()) as BackupManifest;
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version ${manifest.formatVersion} (expected ${BACKUP_FORMAT_VERSION})`
    );
  }
  const blobCount = reader.u32();
  const blobs: BackupBlob[] = [];
  for (let i = 0; i < blobCount; i++) {
    const hash = reader.str();
    const mimeType = reader.str();
    const bytes = reader.lenBytes();
    blobs.push({ hash, mimeType, bytes });
  }
  return { manifest, blobs };
}
