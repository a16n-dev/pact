import type { BaseDocument } from '../types';
import type { CollectionDefinition } from '../collection';
import type { Store } from './store';
import type { DocCipher } from '../crypto/types';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';

/**
 * The schemas in `collections` define which collections exist: write
 * validation, migrations, id prefixes, and the sync enumeration are all
 * derived from them, and reads or writes against an undefined collection
 * are rejected. Only internal `_*` collections live outside the list.
 */
export interface StoreDomain<
  Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[],
> {
  /**
   * Each defined via `defineCollection`. Secondary indexes are declared per
   * collection inside `defineCollection`, not here.
   */
  collections: Defs;
  /**
   * Called from `author.set` after the id is recorded. The Store only tracks
   * who the author is; domains that model the author as a document use this
   * to materialise it (e.g. create a `users/<id>` doc).
   */
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
  /**
   * Blob hashes a document references, unioned across live documents to
   * drive `blobs.prune` and `blobs.pullReferenced`. Omit for domains without
   * blobs: `prune` then refuses to run rather than treat every blob as an
   * orphan. `blobFields` builds this for flat top-level hash fields; write
   * it by hand when references are nested, in arrays, or parsed from a body.
   */
  blobHashes?: (collection: string, doc: BaseDocument) => Iterable<string>;
  /**
   * Seals domain fields into one ciphertext string at rest and on the sync
   * wire; the adapter and server see only base sync fields plus the
   * envelope. Internal `_*` collections and blob bytes are not encrypted.
   *
   * `onUndecryptable` picks the key model. `'throw'` (default): one key per
   * store, held by every client of the app including an agent's MCP Worker,
   * and opening with a wrong key fails fast. `'hide'`: keys coexist; any key
   * opens the store, each document is readable only by the key that sealed
   * it, and undecryptable docs read as missing while staying intact at rest
   * and on the wire. AES-GCM cannot distinguish a wrong key from tampering,
   * so `'hide'` hides tampered envelopes too.
   */
  encryption?: { cipher: DocCipher; onUndecryptable?: 'throw' | 'hide' };
}

/**
 * A `StoreDomain` kept separately can be spread in:
 * `Store.create({ adapter, ...domain })`.
 */
export interface StoreOptions<
  Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[],
> extends StoreDomain<Defs> {
  adapter: DatabaseAdapter;
  /** Omit on consumers that only deal in JSON documents. */
  blobs?: BlobAdapter | null;
  /**
   * Internal plumbing: `Store.create` restores these from the persisted
   * registration. Apps configure sync via `store.sync.register`.
   */
  sync?: StoreSyncConfig;
}

/** Internal plumbing; see `StoreOptions.sync`. */
export interface StoreSyncConfig {
  syncUrl?: string;
  syncToken?: string;
}

/**
 * `docs` entries carry document content without audit fields; the Store
 * stamps those and validates on write. Seeding is skipped while the stored
 * marker matches `version`, so derive it from the seed content (e.g. a hash)
 * or bump it on every seed change.
 */
export interface SeedSet {
  version: string;
  docs: ReadonlyMap<string, ReadonlyArray<{ id: string } & Record<string, unknown>>>;
}

/** Subscriber for `store.on('change')`. */
export type ChangeHandler = (collection: string) => void;
