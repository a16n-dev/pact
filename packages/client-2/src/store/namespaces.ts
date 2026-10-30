import type { BlobAdapter } from '../blobs/blobAdapter';

export type StoreBackup = {
  /**
   * Packs every stored record, tombstones included, into a portable archive,
   * bundling local blobs by default when a blob adapter is present.
   * Internal `_*` state never travels.
   */
  create(opts?: { blobs?: boolean }): Promise<Uint8Array>;
  /**
   * `merge` (the default) runs each archived record through the same merge
   * as sync, so it is safe on a live or partially-synced store. `replace`
   * clears every collection the archive carries, and all blobs if it holds
   * any, then loads it verbatim.
   */
  restore(archive: Uint8Array, opts?: { mode?: RestoreMode }): Promise<RestoreResult>;
};

export type RestoreMode = 'merge' | 'replace';

export type RestoreResult = {
  mode: RestoreMode;
  /** Collections present in the archive. */
  collections: string[];
  /** Archive collections this Store has no definition for; their docs were not restored. */
  collectionsSkipped: string[];
  docsWritten: number;
  /** Merge only: records that changed nothing locally, or were held for a newer schema. */
  docsSkipped: number;
  blobsWritten: number;
  /** Blobs in the archive that could not be restored because the store has no blob adapter. */
  blobsSkipped: number;
};

/**
 * Content-addressed: the key is the SHA-256 of the bytes, so writes are
 * idempotent and dedupe automatically. Requires `StoreOptions.blobs`; the
 * methods that touch bytes throw without one.
 */
export type StoreBlobs = {
  /** null on doc-only stores. */
  readonly adapter: BlobAdapter | null;
  /**
   * Hashes, writes locally, and best-effort pushes to the sync server.
   * Returns the SHA-256 hex digest, which is the blob's identity in every
   * layer. A failed push is retried by `push()`. Bytes over 50 MB are refused.
   */
  write(bytes: Uint8Array, mimeType: string): Promise<string>;
  /** Renderable URI (e.g. `file://…`), or null when the blob is not held locally. */
  uri(hash: string): string | null;
  /** Whether the blob is held locally. */
  has(hash: string): Promise<boolean>;
  /** Hashes of every blob held locally. */
  list(): Promise<string[]>;
  /**
   * Local-only, like `prune`: the server's copy stays, so a document still
   * referencing this hash re-pulls it on the next sync.
   */
  delete(hash: string): Promise<void>;
  /**
   * Uploads the local blobs the server lacks: one round trip for the
   * server's hash set, then PUTs the difference. Idempotent.
   */
  push(): Promise<void>;
  /** Downloads the named blobs where missing locally. Prefer `pullReferenced`. */
  pull(referencedHashes: Iterable<string>): Promise<void>;
  /**
   * Downloads every blob the local documents reference but do not hold.
   * Downloads nothing without a `StoreOptions.blobHashes` extractor.
   */
  pullReferenced(): Promise<void>;
  /** Union of hashes referenced by every live document; empty without an extractor. */
  referencedHashes(): Promise<Set<string>>;
  /**
   * Deletes local blobs no live document references. Local-only: other
   * devices may still reference a blob, so the server's bucket is untouched.
   * Throws without a `blobHashes` extractor; no-op without a blob adapter.
   */
  prune(): Promise<{ deleted: string[] }>;
  /**
   * Signals a local blob-set change made outside these methods (a direct
   * adapter write, an out-of-band delete). Routed through the `change`
   * channel as `_blobs` so UI invalidation can hang off one subscription.
   */
  notifyChanged(): void;
};

/**
 * Runs models through the Pact server's AI routes, signed in as this store.
 * Throws `SyncError` when signed out or when the server refuses, and
 * `UnauthorizedError` (signing the store out) when the token is gone.
 */
export type StoreAi = {
  /** Generates one image and returns its bytes, whatever form the model gave them in. */
  image(request: ImageRequest): Promise<GeneratedImage>;
  /** Asks a decision model the questions about the state. Returns the answers by question key. */
  decide(request: DecisionRequest): Promise<Record<string, unknown>>;
};

export type ImageRequest = {
  /** A Workers AI model, e.g. `openai/gpt-image-1`. */
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  background?: 'transparent' | 'opaque' | 'auto';
  /** Resized and converted on the server. Without it the model's image comes back as it is. */
  output?: ImageOutput;
};

export type ImageOutput = {
  /** 16–2048 px. */
  width?: number;
  /** 16–2048 px. */
  height?: number;
  /** `contain` (the default) fits within the box, `cover` fills it and crops, `scale-down` never enlarges. */
  fit?: 'contain' | 'cover' | 'scale-down';
  format: 'png' | 'webp' | 'jpeg' | 'avif';
  /** 1–100, for the lossy formats. */
  quality?: number;
};

export type GeneratedImage = { bytes: Uint8Array; mimeType: string };

export type DecisionRequest = {
  /** A Workers AI decision model, e.g. `typesafe/jev`. */
  model: string;
  state?: unknown;
  /** In the shape the model takes, keyed by the names the answers come back under. */
  questions: Record<string, unknown>;
};

export type StoreEncryption = {
  /**
   * Verifies, or writes on first encrypted use, the sealed sentinel in
   * `_config/encryption` so a wrong key fails fast. `Store.create` calls this
   * automatically; no-op without encryption. A fresh install opens with any key.
   */
  verifyKey(): Promise<void>;
  /**
   * One-time sweep to enable encryption on an existing install: rewrites
   * every record through the cipher. Idempotent. Follow with `sync.push()`
   * to convert the server's copies.
   */
  encryptLocal(): Promise<{ rewritten: number }>;
};

export type SignInStart = {
  /** The Pact server origin, e.g. `https://sync.example.com`. */
  url: string;
  appId: string;
  /** Shown to the user and the admin, 1–100 chars. */
  deviceName: string;
  /** Must be registered for the app on the server. */
  redirectUri: string;
};

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: 'state' | 'code' | 'network' | 'server' };

export type Registration = { url: string; appId: string; deviceId: string; deviceName: string };

export type Session = { appId: string; user: string | null; deviceName: string };

export type PullResult = {
  applied: number;
  skipped: { drift: number; sealed: number };
  held: number;
};

export type StoreSync = {
  /**
   * Starts OAuth sign-in: fetches the server's discovery document, generates
   * PKCE material and persists it, and returns the URL to open in a browser.
   * Finish with `completeSignIn` once the browser lands on `redirectUri`.
   */
  beginSignIn(start: SignInStart): Promise<{ authorizeUrl: string; state: string }>;
  /** Exchanges the code from the redirect for a token and starts syncing. */
  completeSignIn(input: { code: string; state: string }): Promise<SignInResult>;
  /** Tells the server, forgets the token and closes realtime. Local data is kept. */
  signOut(): Promise<void>;
  /** Asks the server about the stored token; null when not signed in. */
  session(): Promise<Session | null>;
  /** The persisted registration, no network; null before the first sign-in. */
  registration(): Promise<Registration | null>;
  /**
   * Origin and token for direct HTTP calls, such as pointing an
   * OpenAI-compatible SDK at `<url>/ai`. Null when not signed in.
   */
  credentials(): Promise<{ url: string; token: string } | null>;
  /** Pulls every version after the local cursor and merges it in. */
  pull(): Promise<PullResult>;
  /** Fetches every writer's version of one document and merges them all. Does not move the cursor. */
  pullDocument(collection: string, id: string): Promise<void>;
  /**
   * Drains the outbox only: retries the writes the server has not yet
   * accepted. Cost scales with the backlog, so this is what "sync now" paths
   * (app foreground, pull-to-refresh) want. Throws when a chunk fails.
   */
  drain(): Promise<void>;
  /**
   * Drains the outbox, then pushes every record in every synced collection.
   * Cost scales with the database; routine sync paths should use `drain()`.
   */
  push(): Promise<void>;
  /** Documents written locally but not yet accepted by the server. */
  pending(): Promise<number>;
  /**
   * Drops all local state except `_config`, including the outbox, resets
   * the cursor and pulls everything again. Callers with unsynced writes that
   * matter must `push()` first.
   */
  resync(): Promise<PullResult>;
  /** When this device last completed a full pull. */
  lastSyncedAt(): Promise<Date | null>;
};
