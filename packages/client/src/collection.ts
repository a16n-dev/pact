import { z } from 'zod';
import { randomId } from './ids';
import { BaseDocumentSchema, type BaseDocument, type Storable } from './types';
import type { CollectionMigrations, MigrationRegistry } from './migrator';

/**
 * A date field that round-trips through JSON storage and sync. Persisted (and
 * synced) as an ISO string, read back as a `Date`: coercion means the stored
 * string re-parses to a `Date` on every read, on any adapter. Prefer this over
 * a bare `z.date()`, whose output is a `Date` that can't survive serialization
 * — the store re-validates reads, and a serialized `z.date()` throws on read.
 */
export const date = () => z.coerce.date();

/** A document id under `Prefix` — the compile-time face of `docId`. */
export type DocId<Prefix extends string = string> = `${Prefix}-${string}`;

/**
 * Zod field for a document id in the collection with this prefix. Used both
 * for a collection's own `id` (injected by `defineCollection`) and for
 * foreign-key fields referencing another collection's docs. Generic over the
 * prefix literal, so the parsed type is `` `${Prefix}-${string}` `` and a
 * wrong-prefix literal is a compile error, not just a runtime one.
 */
export const docId = <Prefix extends string>(prefix: Prefix) =>
  z.templateLiteral([prefix, '-', z.string()]);

const baseSchemaFor = <Prefix extends string>(idPrefix: Prefix) =>
  BaseDocumentSchema.extend({ id: docId(idPrefix) });

/**
 * `BaseDocumentSchema` with `id` narrowed to the collection's prefix — the
 * starting point handed to `defineCollection`'s schema builder.
 */
export type CollectionBaseSchema<Prefix extends string = string> = ReturnType<
  typeof baseSchemaFor<Prefix>
>;

export interface CollectionDefinition<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  IdPrefix extends string = string,
> {
  name: Name;
  /**
   * The collection's physical identity: the storage/wire key documents are
   * kept and synced under. Defaults to `name`. Setting it decouples the
   * label code uses from what local storage and the sync server ever see —
   * an opaque key (e.g. `c1`) keeps the domain vocabulary out of server
   * rows. A rename-not-encryption measure: the mapping ships in the app
   * bundle, and changing a key orphans data stored under the old one.
   */
  key: string;
  idPrefix: IdPrefix;
  /**
   * Whether the collection is enumerated for sync (`pushAll` / pull-all).
   * Local-only collections set this false: their docs are still validated and
   * migrated, but never leave the device.
   */
  synced: boolean;
  schema: Schema;
  migrations?: CollectionMigrations;
  generateId: () => DocId<IdPrefix>;
}

const DEFAULT_ID_LENGTH = 10;

/** What `defineCollection` takes: the hand-written half of a `CollectionDefinition`. */
export interface CollectionConfig<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  IdPrefix extends string = string,
> {
  /** The name code refers to the collection by (`store.collection(name)`). */
  name: Name;
  /** Storage/wire key; defaults to `name`. See `CollectionDefinition.key`. */
  key?: string;
  /** Prefix for this collection's ids (`rcp` → `rcp-Ab3xY9kQz2`). Must be unique across the domain. */
  idPrefix: IdPrefix;
  /** Length of the random part of generated ids. Default 10. */
  idLength?: number;
  /** Whether docs sync. Default true; set false for local-only collections. */
  synced?: boolean;
  /** The collection's migration chain; see `CollectionMigrations`. */
  migrations?: CollectionMigrations;
  /**
   * Builds the document schema from a base that already carries the audit
   * fields and the prefix-checked `id`, so the prefix is declared once:
   * `(base) => base.extend({ title: z.string() })`.
   */
  schema: (base: CollectionBaseSchema<IdPrefix>) => Schema;
}

/**
 * Single source of truth for a collection: its name, id prefix, document
 * schema, and migration chain. The list of these handed to the Store *is*
 * the set of available collections — the Store derives its validation,
 * migrator, id parsing, and sync enumeration from it, and rejects reads
 * and writes against any collection not in the list.
 */
export function defineCollection<
  Name extends string,
  Schema extends z.ZodType<Storable>,
  IdPrefix extends string,
>(def: CollectionConfig<Name, Schema, IdPrefix>): CollectionDefinition<Name, Schema, IdPrefix> {
  const {
    name,
    key = name,
    idPrefix,
    idLength = DEFAULT_ID_LENGTH,
    synced = true,
    migrations,
  } = def;
  if (key.startsWith('_')) {
    throw new Error(`Collection key "${key}" is reserved (the _* namespace is internal)`);
  }
  return {
    name,
    key,
    idPrefix,
    synced,
    migrations,
    schema: def.schema(baseSchemaFor(idPrefix)),
    generateId: () => `${idPrefix}-${randomId(idLength)}`,
  };
}

/** A document id decomposed into the collection it belongs to and its parts. */
export interface ParsedId {
  /** The owning collection's name. */
  collection: string;
  /** The prefix code (the part before the first `-`). */
  prefix: string;
  /** The id with the prefix and separator stripped. */
  localId: string;
}

/**
 * Builds a parser that maps a document id back to its collection by splitting
 * off the prefix at the first `-` and looking it up. Prefixes may be any
 * length (they can't contain `-`). Returns `null` for ids whose prefix isn't
 * known or that carry no `-` — callers use that to tell a real doc reference
 * apart from arbitrary text (e.g. a markdown link). Throws if two collections
 * share a prefix.
 */
export function createIdParser(
  collections: readonly CollectionDefinition[]
): (id: string) => ParsedId | null {
  const byPrefix = new Map(collections.map((c) => [c.idPrefix, c.name]));
  if (byPrefix.size !== collections.length) {
    throw new Error('Duplicate collection id prefix');
  }
  return (id: string): ParsedId | null => {
    if (typeof id !== 'string') return null;
    const sep = id.indexOf('-');
    if (sep <= 0) return null;
    const prefix = id.slice(0, sep);
    const collection = byPrefix.get(prefix);
    return collection ? { collection, prefix, localId: id.slice(sep + 1) } : null;
  };
}

export function buildMigrationRegistry(
  collections: readonly CollectionDefinition[]
): MigrationRegistry {
  const registry: MigrationRegistry = {};
  for (const collection of collections) {
    if (collection.migrations) registry[collection.name] = collection.migrations;
  }
  return registry;
}

/** Union of the collection names in a definition list. */
export type CollectionName<Defs extends readonly CollectionDefinition[]> = Defs[number]['name'];

/**
 * Document type of the named collection, inferred from its schema. Falls
 * back to `BaseDocument` when the definition list isn't statically known
 * (the intersection is what keeps the result assignable to `BaseDocument`).
 */
export type DocumentOf<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = z.output<Extract<Defs[number], { name: Name }>['schema']> & BaseDocument;
