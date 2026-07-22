import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildMigrationRegistry, createIdParser, defineCollection } from './collection';
import { Migrator } from './migrator';

const widgets = defineCollection({
  name: 'widgets',
  idPrefix: 'wg',
  migrations: {
    current: 2,
    migrations: [{ from: 1, to: 2, up: (doc) => ({ ...doc, label: doc.name }) }],
  },
  schema: (base) => base.extend({ label: z.string().min(1) }),
});

const localNotes = defineCollection({
  name: 'localNotes',
  idPrefix: 'ln',
  idLength: 4,
  synced: false,
  schema: (base) => base.extend({ text: z.string() }),
});

const baseFields = {
  schemaVersion: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'us/test',
  updatedBy: 'us/test',
  deletedAt: null,
  deletedBy: null,
};

describe('defineCollection', () => {
  it('generates ids with the collection prefix and length', () => {
    const id = widgets.generateId();
    expect(id).toMatch(/^wg-[A-Za-z0-9]{10}$/);
    expect(localNotes.generateId()).toMatch(/^ln-[A-Za-z0-9]{4}$/);
  });

  it('injects the prefix-checked id into the schema', () => {
    const doc = { ...baseFields, id: 'wg-abc', label: 'a' };
    expect(() => widgets.schema.parse(doc)).not.toThrow();
    expect(() => widgets.schema.parse({ ...doc, id: 'ln-abc' })).toThrow();
  });
});

describe('createIdParser', () => {
  const parseId = createIdParser([widgets, localNotes]);

  it('parses ids back to their collection by splitting on the first dash', () => {
    expect(parseId('wg-abc')).toEqual({
      collection: 'widgets',
      prefix: 'wg',
      localId: 'abc',
    });
    // localId keeps any further dashes (e.g. a seed key like `yellow-onion`).
    expect(parseId('ln-yellow-onion')).toEqual({
      collection: 'localNotes',
      prefix: 'ln',
      localId: 'yellow-onion',
    });
    expect(parseId('zz-abc')).toBeNull();
    expect(parseId('wg')).toBeNull();
  });

  it('handles prefixes of differing lengths', () => {
    const longPrefixed = defineCollection({
      name: 'longPrefixed',
      idPrefix: 'widget',
      schema: (base) => base,
    });
    const parse = createIdParser([widgets, longPrefixed]);
    expect(parse('widget-xyz')).toEqual({
      collection: 'longPrefixed',
      prefix: 'widget',
      localId: 'xyz',
    });
    expect(parse('wg-xyz')).toMatchObject({ collection: 'widgets' });
  });

  it('throws when two collections share a prefix', () => {
    const clash = defineCollection({ name: 'clash', idPrefix: 'wg', schema: (base) => base });
    expect(() => createIdParser([widgets, clash])).toThrow(/prefix/i);
  });
});

describe('buildMigrationRegistry', () => {
  it('skips collections without migrations', () => {
    const registry = buildMigrationRegistry([widgets, localNotes]);
    expect(Object.keys(registry)).toEqual(['widgets']);
  });

  it('binds each collection chain for the migrator', () => {
    const migrator = new Migrator(buildMigrationRegistry([widgets, localNotes]));
    expect(migrator.currentVersion('widgets')).toBe(2);
    const migrated = migrator.migrate<{ label: string }>('widgets', {
      ...baseFields,
      schemaVersion: 1,
      id: 'wg-abc',
      name: 'a',
    });
    expect(migrated.label).toBe('a');
  });
});
