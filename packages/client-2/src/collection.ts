import { z } from 'zod';
import { randomId } from './lib/ids';
import { BaseDocumentSchema, type BaseDocument, type Storable } from './types';
import type { CollectionMigrations } from './migrator';
import type { IndexMap } from './store/indexes';
import { textEngineOf, type TextEngine } from './text/engine';

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

/**
 * `field`: one clock per field, fields merge independently. `document`: one
 * clock per record, the record with the greater clock wins wholesale.
 */
export type MergeMode = 'field' | 'document';

export type CollectionDefinition<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  IdPrefix extends string = string,
  // Bounded by `IndexMap<never>`, not `IndexMap<BaseDocument>`: extractors are
  // contravariant in the document type, so only the `never` bound accepts an
  // index map written for a specific document shape.
  Idx extends IndexMap<never> = IndexMap<never>,
> = {
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
  merge: MergeMode;
  schema: Schema;
  /** Schema keys declared with a text helper such as `yText()`. */
  textFields: readonly string[];
  /** Null when the collection declares no text fields. */
  textEngine: TextEngine | null;
  migrations?: CollectionMigrations;
  generateId: () => DocId<IdPrefix>;
  indexes: Idx;
};

const DEFAULT_ID_LENGTH = 10;
const MAX_KEY_LENGTH = 256;

export type CollectionConfig<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
  IdPrefix extends string = string,
> = {
  name: Name;
  /** Defaults to `name`; see `CollectionDefinition.key`. 1–256 characters. */
  key?: string;
  /** Must be unique across the domain and must not contain `-`. */
  idPrefix: IdPrefix;
  /** Length of the random part of generated ids; defaults to 10. */
  idLength?: number;
  /** Defaults to true. */
  synced?: boolean;
  /** Defaults to `field`. Cannot be changed once data exists. */
  merge?: MergeMode;
  migrations?: CollectionMigrations;
  /**
   * Receives a base that already carries the base fields and the
   * prefix-checked `id`: `(base) => base.extend({ title: z.string() })`.
   */
  schema: (base: CollectionBaseSchema<IdPrefix>) => Schema;
};

/**
 * Indexes are a second step because their extractors take the document type
 * inferred from the schema; both in one object literal deadlocks inference.
 */
export type CollectionBuilder<
  Name extends string,
  Schema extends z.ZodType,
  IdPrefix extends string,
> = CollectionDefinition<Name, Schema, IdPrefix, Record<string, never>> & {
  /**
   * Each extractor maps a document to the key or keys it is found under via
   * `listByIndex(indexName, key)`; equality lookups only. Indexes are rebuilt
   * in memory from the decrypted, migrated docs on every `Store.create` and
   * are never persisted or synced.
   */
  withIndexes<Idx extends IndexMap<z.output<Schema> & BaseDocument>>(
    indexes: Idx
  ): CollectionDefinition<Name, Schema, IdPrefix, Idx>;
};

export function assertKeyLength(what: string, value: string): void {
  if (value.length < 1 || value.length > MAX_KEY_LENGTH) {
    throw new Error(`${what} must be 1–${MAX_KEY_LENGTH} characters: "${value}"`);
  }
}

function findTextFields(schema: z.ZodType): { fields: string[]; engine: TextEngine | null } {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  const fields: string[] = [];
  let engine: TextEngine | null = null;
  if (!shape) return { fields, engine };
  for (const [name, field] of Object.entries(shape)) {
    const found = textEngineOf(field);
    if (!found) continue;
    if (engine && engine !== found) {
      throw new Error(`Collection text fields must share one text engine ("${name}" differs)`);
    }
    engine = found;
    fields.push(name);
  }
  return { fields, engine };
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
    merge = 'field',
    migrations,
  } = def;
  if (key.startsWith('_')) {
    throw new Error(`Collection key "${key}" is reserved (the _* namespace is internal)`);
  }
  assertKeyLength('Collection key', key);
  if (idPrefix.includes('-')) {
    throw new Error(`Collection id prefix "${idPrefix}" must not contain "-"`);
  }
  const schema = def.schema(baseSchemaFor(idPrefix));
  const text = findTextFields(schema);
  if (merge === 'document' && text.fields.length > 0) {
    throw new Error(`Collection "${name}" merges by document and cannot declare text fields`);
  }
  const base = {
    name,
    key,
    idPrefix,
    synced,
    merge,
    migrations,
    schema,
    textFields: text.fields,
    textEngine: text.engine,
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

export type CollectionName<Defs extends readonly CollectionDefinition[]> = Defs[number]['name'];

/**
 * The intersection with `BaseDocument` keeps the result assignable to
 * `BaseDocument` when the definition list is not statically known.
 */
export type DocumentOf<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = z.output<Extract<Defs[number], { name: Name }>['schema']> & BaseDocument;

export type DocumentInputOf<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = Omit<z.input<Extract<Defs[number], { name: Name }>['schema']>, keyof BaseDocument>;

export type CollectionIndexNames<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = keyof Extract<Defs[number], { name: Name }>['indexes'] & string;

export type CollectionTextFields<
  Defs extends readonly CollectionDefinition[],
  Name extends CollectionName<Defs>,
> = Extract<Defs[number], { name: Name }>['textFields'][number];
