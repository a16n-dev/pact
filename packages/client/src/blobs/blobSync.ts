import type { BlobAdapter } from './blobAdapter';

// Because a blob's hash is its identity on every layer (local store, R2 key,
// doc reference), sync needs no cursor: push uploads local − server and pull
// downloads referenced − local. Both sides of each diff come from authoritative
// listings, so a failed or interrupted sync self-heals on the next one.
export interface BlobSyncDeps {
  adapter: BlobAdapter;
  // Null when the store isn't registered with a sync server.
  credentials(): Promise<{ url: string; token: string } | null>;
  notifyChanged(): void;
}

export class BlobSync {
  private readonly blobs: BlobAdapter;
  private readonly deps: BlobSyncDeps;

  constructor(deps: BlobSyncDeps) {
    this.blobs = deps.adapter;
    this.deps = deps;
  }

  async write(bytes: Uint8Array, mimeType: string): Promise<string> {
    const hash = await sha256Hex(bytes);
    await this.blobs.write(hash, bytes, mimeType);
    this.deps.notifyChanged();
    // Best-effort; a failed upload is retried by the next push().
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

  // Local-only eviction: the server copy stays, so a doc still referencing the
  // hash re-pulls it on the next sync.
  async delete(hash: string): Promise<void> {
    await this.blobs.delete(hash);
    this.deps.notifyChanged();
  }

  // A stale server listing only costs a duplicate PUT, which the server
  // collapses because the key is the content hash.
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
    } catch {}
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
