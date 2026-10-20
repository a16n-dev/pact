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
   * Seals every stored record at rest and on the sync wire; the adapter and
   * server see only `hlc`, `collection`, `id` and the envelope. Internal
   * `_*` collections and blob bytes are not encrypted. Every client of the
   * app must hold the same key: a pulled version sealed under another key
   * is skipped, so clients with different keys never see each other's
   * documents.
   */
  encryption?: { cipher: DocCipher };
  /**
   * What to make of a record sealed under a key this store does not hold.
   * `'throw'` (the default) keeps one key per app: opening an install that
   * holds data with a different key fails fast, and so does reading such a
   * record. `'hide'` lets keys coexist, with or without a cipher of its own:
   * any key opens the store, each record is readable only by the key that
   * sealed it, and the rest read as missing while staying intact at rest and
   * on the wire. A pulled record sealed under another key is kept locally
   * and competes by clock, so the newest write wins wholesale. AES-GCM cannot
   * tell a wrong key from tampering, so `'hide'` hides tampered envelopes too.
   */
  onUndecryptable?: 'throw' | 'hide';
};

/** Subscriber for `store.on('change')`. Blob activity arrives as `_blobs`. */
export type ChangeHandler = (collection: string) => void;
