import { z } from 'zod';
import { nanoid } from 'nanoid';
import { BaseDocumentSchema } from './types';
import { Migrator, type CollectionMigrations, type MigrationRegistry } from './migrator';
import type { StoreDomain } from './store';

/**
 * Zod field for a document id in the collection with this prefix. Used both
 * for a collection's own `id` (injected by `defineCollection`) and for
 * foreign-key fields referencing another collection's docs.
 */
export const docId = (prefix: string) => z.string().startsWith(`${prefix}/`);

const baseSchemaFor = (idPrefix: string) => BaseDocumentSchema.extend({ id: docId(idPrefix) });

/**
 * `BaseDocumentSchema` with `id` narrowed to the collection's prefix — the
 * starting point handed to `defineCollection`'s schema builder.
 */
export type CollectionBaseSchema = ReturnType<typeof baseSchemaFor>;

export interface CollectionDefinition<
  Name extends string = string,
  Schema extends z.ZodType = z.ZodType,
> {
  name: Name;
  idPrefix: string;
  /**
   * Whether the collection is enumerated for sync (`pushAll` / pull-all).
   * Local-only collections set this false: their docs are still validated and
   * migrated, but never leave the device.
   */
  synced: boolean;
  schema: Schema;
  migrations?: CollectionMigrations;
  generateId: () => string;
}

const DEFAULT_ID_LENGTH = 10;

/**
 * Single source of truth for a collection: its name, id prefix, document
 * schema, and migration chain. `createDomain` derives the Store wiring
 * (validation, migrator, sync enumeration) from a list of these.
 */
export function defineCollection<Name extends string, Schema extends z.ZodType>(def: {
  name: Name;
  idPrefix: string;
  /** Length of the random part of generated ids. */
  idLength?: number;
  synced?: boolean;
  migrations?: CollectionMigrations;
  /**
   * Builds the document schema from a base that already carries the audit
   * fields and the prefix-checked `id`, so the prefix is declared once.
   */
  schema: (base: CollectionBaseSchema) => Schema;
}): CollectionDefinition<Name, Schema> {
  const { name, idPrefix, idLength = DEFAULT_ID_LENGTH, synced = true, migrations } = def;
  return {
    name,
    idPrefix,
    synced,
    migrations,
    schema: def.schema(baseSchemaFor(idPrefix)),
    generateId: () => `${idPrefix}/${nanoid(idLength)}`,
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

/**
 * Builds a `StoreDomain` from collection definitions: writes are parsed
 * against their collection's schema (unknown collections — e.g. internal
 * `_config`, `_sync_meta` — pass through unchanged), the migrator walks each
 * collection's chain, and the sync enumeration lists `synced` collections.
 */
export function createDomain(
  collections: readonly CollectionDefinition[],
  hooks?: Pick<StoreDomain, 'onSetAuthor'>
): StoreDomain {
  const schemas = new Map<string, z.ZodType>(collections.map((c) => [c.name, c.schema]));
  return {
    ...hooks,
    migrator: new Migrator(buildMigrationRegistry(collections)),
    collections: collections.filter((c) => c.synced).map((c) => c.name),
    validate: (collection, doc) => {
      const schema = schemas.get(collection);
      return schema ? schema.parse(doc) : doc;
    },
  };
}
