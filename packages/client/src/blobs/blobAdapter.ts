/**
 * Content-addressed byte storage alongside a `DatabaseAdapter`. Keys are the
 * SHA-256 hex digest of the bytes, so writes are idempotent and equal content
 * dedupes to one entry.
 */
export interface BlobAdapter {
  has(hash: string): Promise<boolean>;
  read(hash: string): Promise<Uint8Array | null>;
  /** Null for a blob stored before MIME types were recorded. */
  mimeType(hash: string): Promise<string | null>;
  write(hash: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  delete(hash: string): Promise<void>;
  list(): Promise<string[]>;
  /** Renderable URI (e.g. `file://`) for a locally present blob, else null. */
  uriFor(hash: string): string | null;
}
