import type { BaseDocument } from '../types';
import type { CollectionDefinition } from '../collection';
import type { DocCipher } from '../crypto/types';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BlobAdapter } from '../blobs/blobAdapter';

/**
 * The schemas in `collections` define which collections exist: write
 * validation, migrations, id prefixes, and the sync enumeration are all
 * derived from them, and reads or writes against an undefined collection
 * are rejected. Only internal `_*` collections live outside the list.
 */
export type StoreOptions<
  Defs extends readonly CollectionDefinition[] = readonly CollectionDefinition[],
> = {
  adapter: DatabaseAdapter;
  /** Each defined via `defineCollection`. */
  collections: Defs;
  /** Omit on consumers that only deal in JSON documents. */
  blobs?: BlobAdapter | null;
  /**
   * Blob hashes a document references, unioned across live documents to
   * drive `blobs.prune` and `blobs.pullReferenced`. Omit for domains without
   * blobs: `prune` then refuses to run rather than treat every blob as an
   * orphan. `blobFields` builds this for flat top-level hash fields; write
   * it by hand when references are nested, in arrays, or parsed from a body.
   */
  blobHashes?: (collection: string, doc: BaseDocument) => Iterable<string>;
  /**
   * The key the store opens with; `encryption.setKey` changes it later. Each
   * key is a lens: the store shows only the documents sealed under it, at
   * rest and on the sync wire, and the adapter and server see only `hlc`,
   * `collection`, `id` and the envelope. Without a key the store shows the
   * plain documents. Blob bytes and the internal `_*` collections other than
   * `_tasks` are not encrypted.
   */
  encryption?: { cipher: DocCipher };
};

/** Subscriber for `store.on('change')`. Blob activity arrives as `_blobs`. */
export type ChangeHandler = (collection: string) => void;
