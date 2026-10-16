import { z } from 'zod';
import { randomId } from './ids';
import { BaseDocumentSchema, type BaseDocument, type Storable } from './types';
import type { CollectionMigrations, MigrationRegistry } from './migrator';
import type { IndexMap } from './store/indexes';

/**
 * Persisted and synced as an ISO string, read back as a `Date`. Use this
 * instead of a bare `z.date()`: the store re-validates on every read, and a
 * `z.date()` value that has been serialized fails that re-parse.
 */
export const date = () => z.coerce.date();

export type DocId<Prefix extends string = string> = `${Prefix}-${string}`;

/**
 * Zod field for an id in the collection with this prefix. `defineCollection`
 * injects it for a collection's own `id`; use it directly for foreign-key
 * fields. A wrong-prefix literal is a compile error, not only a runtime one.
 */
export const docId = <Prefix extends string>(prefix: Prefix) =>
  z.templateLiteral([prefix, '-', z.string()]);

const baseSchemaFor = <Prefix extends string>(idPrefix: Prefix) =>
  BaseDocumentSchema.extend({ id: docId(idPrefix) });

export type CollectionBaseSchema<Prefix extends string = string> = ReturnType<
  typeof baseSchemaFor<Prefix>
>;

export interface CollectionDefinition<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  IdPrefix extends string = string,
  // Bounded by `IndexMap<never>`, not `IndexMap<BaseDocument>`: extractors are
  // contravariant in the document type, so only the `never` bound accepts an
  // index map written for a specific document shape.
  Idx extends IndexMap<never> = IndexMap<never>,
> {
  name: Name;
  /**
   * Storage and wire key, defaulting to `name`. An opaque key keeps domain
   * vocabulary out of server rows but is not encryption (the mapping ships in
   * the bundle), and changing it orphans data stored under the old key.
   */
  key: string;
  idPrefix: IdPrefix;
  /** False for local-only collections: still validated and migrated, never pushed or pulled. */
  synced: boolean;
  schema: Schema;
  migrations?: CollectionMigrations;
  generateId: () => DocId<IdPrefix>;
  indexes: Idx;
}

const DEFAULT_ID_LENGTH = 10;

export interface CollectionConfig<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  IdPrefix extends string = string,
> {
  name: Name;
  /** Defaults to `name`; see `CollectionDefinition.key`. */
  key?: string;
  /** Must be unique across the domain and must not contain `-`. */
  idPrefix: IdPrefix;
  /** Length of the random part of generated ids; defaults to 10. */
  idLength?: number;
  /** Defaults to true. */
  synced?: boolean;
  migrations?: CollectionMigrations;
  /**
   * Receives a base that already carries the audit fields and the
   * prefix-checked `id`: `(base) => base.extend({ title: z.string() })`.
   */
  schema: (base: CollectionBaseSchema<IdPrefix>) => Schema;
}

/**
 * Indexes are a second step because their extractors take the document type
 * inferred from the schema; both in one object literal deadlocks inference.
 */
export interface CollectionBuilder<
  Name extends string,
  Schema extends z.ZodType,
  IdPrefix extends string,
> extends CollectionDefinition<Name, Schema, IdPrefix, Record<string, never>> {
  /**
   * Each extractor maps a document to the key or keys it is found under via
   * `listByIndex(indexName, key)`; equality lookups only. Indexes are rebuilt
   * in memory from the decrypted, migrated docs on every `Store.create` and
   * are never persisted or synced.
   */
  withIndexes<Idx extends IndexMap<z.output<Schema> & BaseDocument>>(
    indexes: Idx
  ): CollectionDefinition<Name, Schema, IdPrefix, Idx>;
}

/**
 * The definitions handed to the Store are the complete set of collections;
 * reads or writes against any other collection are rejected.
 */
export function defineCollection<
  Name extends string,
  Schema extends z.ZodType<Storable>,
  IdPrefix extends string,
>(def: CollectionConfig<Name, Schema, IdPrefix>): CollectionBuilder<Name, Schema, IdPrefix> {
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
  const base = {
    name,
    key,
    idPrefix,
    synced,
    migrations,
    schema: def.schema(baseSchemaFor(idPrefix)),
    generateId: () => `${idPrefix}-${randomId(idLength)}` as DocId<IdPrefix>,
  };
  return {
    ...base,
    indexes: {},
    withIndexes(indexes) {
      return { ...base, indexes };
    },
  } as CollectionBuilder<Name, Schema, IdPrefix>;
}

export interface ParsedId {
  collection: string;
  prefix: string;
  localId: string;
}

/**
 * The parser returns `null` for an unknown prefix or an id with no `-`, which
 * lets callers tell a document reference apart from arbitrary text.
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

export type CollectionName<Defs extends readonly CollectionDefinition[]> = Defs[number]['name'];

/**
 * The intersection with `BaseDocument` keeps the result assignable to
 * `BaseDocument` when the definition list is not statically known.
 */
export type DocumentOf<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = z.output<Extract<Defs[number], { name: Name }>['schema']> & BaseDocument;

export type CollectionIndexNames<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = keyof Extract<Defs[number], { name: Name }>['indexes'] & string;
