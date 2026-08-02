import type { BlobAdapter } from './blobAdapter';

/**
 * Content-addressed byte sync — the engine behind `store.blobs`. Not part of
 * the public API; the Store wires it up with its own credentials and change
 * signal and exposes the methods on the `blobs` namespace.
 *
 * The hash is the identity, so:
 *   - writes are idempotent (same bytes → same key)
 *   - "is this synced?" is set membership, not a temporal cursor
 *   - push = upload `localBlobs − serverBlobs`
 *   - pull = download `referencedHashes − localBlobs`
 *
 * Failures self-heal on the next sync: stale local state can't drift from
 * reality because both sides of the diff come from authoritative sources
 * (the filesystem and the server's bucket listing).
 */
export interface BlobSyncDeps {
  adapter: BlobAdapter;
  /** Sync url + token, or null when the store isn't registered. */
  credentials(): Promise<{ url: string; token: string } | null>;
  /** The Store's blob-change signal (`store.blobs.notifyChanged`). */
  notifyChanged(): void;
}

export class BlobSync {
  private readonly blobs: BlobAdapter;
  private readonly deps: BlobSyncDeps;

  constructor(deps: BlobSyncDeps) {
    this.blobs = deps.adapter;
    this.deps = deps;
  }

  /**
   * Hash, write locally, and best-effort push to the sync server. Returns
   * the SHA-256 hex digest, which is the blob's identity in every layer
   * (filesystem, R2 key, doc reference). Failed pushes retry on `push()`.
   */
  async write(bytes: Uint8Array, mimeType: string): Promise<string> {
    const hash = await sha256Hex(bytes);
    await this.blobs.write(hash, bytes, mimeType);
    this.deps.notifyChanged();
    void this.tryPush(hash, bytes, mimeType);
    return hash;
  }

  uri(hash: string): string | null {
    return this.blobs.uriFor(hash);
  }

  has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  list(): Promise<string[]> {
    return this.blobs.list();
  }

  /**
   * Evict a blob from local storage. Local-only, like `prune`: the server's
   * copy stays, so a document still referencing this hash re-pulls it on the
   * next sync. Signals the change so blob-backed UI re-reads.
   */
  async delete(hash: string): Promise<void> {
    await this.blobs.delete(hash);
    this.deps.notifyChanged();
  }

  /**
   * Upload local blobs the server doesn't have yet. One round trip to
   * fetch the server's hash set, then PUT the difference. Idempotent —
   * a stale server-set cache just means a duplicate PUT, which R2
   * collapses since the key is the content hash.
   */
  async push(): Promise<void> {
    const creds = await this.deps.credentials();
    if (!creds) return;
    const local = await this.blobs.list();
    const remote = new Set(await this.fetchServerList(creds));
    for (const hash of local) {
      if (remote.has(hash)) continue;
      const bytes = await this.blobs.read(hash);
      if (!bytes) continue;
      const mimeType = (await this.blobs.mimeType(hash)) ?? 'application/octet-stream';
      await this.tryPush(hash, bytes, mimeType, creds);
    }
  }

  /**
   * Download blobs referenced by docs but missing locally. Caller passes the
   * union of hashes referenced across all doc collections.
   */
  async pull(referencedHashes: Iterable<string>): Promise<void> {
    const creds = await this.deps.credentials();
    if (!creds) return;
    let any = false;
    for (const hash of referencedHashes) {
      if (await this.blobs.has(hash)) continue;
      const blob = await this.tryFetch(creds, hash);
      if (blob) {
        await this.blobs.write(hash, blob.bytes, blob.mimeType);
        any = true;
      }
    }
    if (any) this.deps.notifyChanged();
  }

  private async tryPush(
    hash: string,
    bytes: Uint8Array,
    mimeType: string,
    creds?: { url: string; token: string }
  ): Promise<void> {
    const c = creds ?? (await this.deps.credentials());
    if (!c) return;
    try {
      await fetch(`${c.url}/sync/blobs/${hash}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${c.token}`, 'content-type': mimeType },
        body: bytes as Uint8Array<ArrayBuffer>,
      });
    } catch {
      // Network failures retry via push() on next sync.
    }
  }

  private async tryFetch(
    creds: { url: string; token: string },
    hash: string
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    try {
      const res = await fetch(`${creds.url}/sync/blobs/${hash}`, {
        headers: { Authorization: `Bearer ${creds.token}` },
      });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
      return { bytes, mimeType };
    } catch {
      return null;
    }
  }

  private async fetchServerList(creds: { url: string; token: string }): Promise<string[]> {
    try {
      const res = await fetch(`${creds.url}/sync/blobs`, {
        headers: { Authorization: `Bearer ${creds.token}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { hashes: string[] };
      return data.hashes;
    } catch {
      return [];
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
