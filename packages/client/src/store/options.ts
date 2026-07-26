// How a Store is initialised and configured. These are the types an app
// touches when setting Pact up; the namespaced runtime surface lives in
// `namespaces.ts`, and internal bookkeeping shapes in `types.ts`.
import type { BaseDocument } from '../types';
import type { CollectionDefinition } from '../collection';
import type { Store } from './store';
import type { DocCipher } from '../crypto/types';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';

/**
 * The consuming domain's configuration for a Store. Its heart is
 * `collections`: the schemas provided here *define* which collections exist.
 * The Store derives everything schema-adjacent from them — write validation
 * (each collection's Zod schema), the migrator (each collection's migration
 * chain), id parsing (each collection's id prefix), and the sync enumeration
 * (`synced` collections) — and rejects reads and writes against any
 * collection that isn't defined. Only internal `_*` collections live outside
 * the definition list.
 */
export interface StoreDomain<
  Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[],
> {
  /**
   * The collections this Store serves, each defined via `defineCollection`.
   * Required — a collection with no definition (and therefore no schema)
   * does not exist as far as the Store is concerned. Secondary indexes are
   * declared per-collection inside `defineCollection` (see its `indexes`
   * option), not here.
   */
  collections: Defs;
  /**
   * Called from `author.set` after the current-author id is recorded, with
   * the Store and the new author id. The generic Store only tracks *who* the
   * current author is (in `_config/author`); domains that model the author as
   * an actual document use this hook to materialize that entity (e.g. create
   * a `users/<id>` doc). No-op when omitted.
   */
  onSetAuthor?: (store: Store, authorId: string) => Promise<void>;
  /**
   * Blob hashes a document references. The Store unions these across all
   * *live* documents to power blob garbage collection (`store.blobs.prune`)
   * and reference-driven pull (`store.blobs.pullReferenced`). Omit for domains
   * with no blobs — `prune` then refuses to run rather than treat every blob
   * as an orphan. For the common case of flat top-level hash fields, build
   * this with the `blobFields` helper; write it by hand when references are
   * nested, in arrays, or parsed out of a body.
   */
  blobHashes?: (collection: string, doc: BaseDocument) => Iterable<string>;
  /**
   * Optional end-to-end document encryption. When set, domain fields are
   * sealed into one ciphertext string both at rest (the adapter only ever
   * stores ciphertext; docs are decrypted as they're read into memory) and
   * on the sync wire — the server sees base sync fields plus the envelope.
   * All clients of the app (including an agent's MCP Worker) must hold the
   * same key. Internal `_*` collections and blob bytes are not encrypted.
   */
  encryption?: { cipher: DocCipher };
}

/**
 * Everything a Store needs, in one bag: the domain (collections, encryption,
 * hooks — see `StoreDomain`) plus the physical backends. A domain object can
 * be kept separately and spread in: `Store.create({ adapter, ...domain })`.
 */
export interface StoreOptions<
  Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[],
> extends StoreDomain<Defs> {
  /** Storage backend for JSON documents. */
  adapter: DatabaseAdapter;
  /** Sidecar for opaque byte blobs. Omit on consumers that only deal in JSON docs. */
  blobs?: BlobAdapter | null;
  /**
   * Explicit sync credentials. Internal plumbing — `Store.create` restores
   * these from the persisted registration; apps configure sync via
   * `store.sync.register`, not by passing this.
   */
  sync?: StoreSyncConfig;
}

/** Sync credentials, as carried by `StoreOptions.sync`. Internal plumbing. */
export interface StoreSyncConfig {
  syncUrl?: string;
  syncToken?: string;
}

/**
 * A versioned set of seed documents for `store.seed`. `docs` entries carry the
 * document content (sans audit fields) plus its id; the Store stamps audit
 * fields and validates on write. `version` identifies the payload — seeding is
 * skipped entirely while the stored marker matches it, so derive it from the
 * seed content (e.g. a hash) or bump it manually on every seed change.
 */
export interface SeedSet {
  version: string;
  docs: ReadonlyMap<string, ReadonlyArray<{ id: string } & Record<string, unknown>>>;
}

/** Subscriber for `store.on('change')`, called with the collection that changed. */
export type ChangeHandler = (collection: string) => void;
