/**
 * Sidecar to `DatabaseAdapter` for content-addressed byte blobs. Keys are
 * SHA-256 hex digests of the bytes, so identity falls out of content:
 * writes are idempotent, dedupe is automatic, and "is this the same blob"
 * is a string comparison.
 */
export interface BlobAdapter {
  has(hash: string): Promise<boolean>;
  read(hash: string): Promise<Uint8Array | null>;
  /** Stored MIME type for a blob, or null when unknown (e.g. a legacy blob). */
  mimeType(hash: string): Promise<string | null>;
  write(hash: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  delete(hash: string): Promise<void>;
  /** Hashes of every blob currently stored locally. */
  list(): Promise<string[]>;
  /**
   * Renderable URI for a stored blob (e.g. local `file://`). Null when
   * the blob isn't present locally.
   */
  uriFor(hash: string): string | null;
}
