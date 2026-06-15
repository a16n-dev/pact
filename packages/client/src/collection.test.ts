import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildMigrationRegistry, createDomain, defineCollection } from './collection';

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
    expect(id).toMatch(/^wg\/.{10}$/);
    expect(localNotes.generateId()).toMatch(/^ln\/.{4}$/);
  });

  it('injects the prefix-checked id into the schema', () => {
    const doc = { ...baseFields, id: 'wg/abc', label: 'a' };
    expect(() => widgets.schema.parse(doc)).not.toThrow();
    expect(() => widgets.schema.parse({ ...doc, id: 'ln/abc' })).toThrow();
  });
});

describe('createDomain', () => {
  const domain = createDomain([widgets, localNotes]);

  it('enumerates only synced collections', () => {
    expect(domain.collections).toEqual(['widgets']);
  });

  it('validates docs in known collections and passes unknown ones through', () => {
    const doc = { ...baseFields, id: 'wg/abc', label: 'a' };
    expect(domain.validate!('widgets', doc)).toEqual(doc);
    expect(() => domain.validate!('widgets', { ...doc, label: '' })).toThrow();
    const opaque = { anything: true };
    expect(domain.validate!('_config', opaque)).toBe(opaque);
  });

  it('binds the migrator to each collection chain', () => {
    expect(domain.migrator!.currentVersion('widgets')).toBe(2);
    const migrated = domain.migrator!.migrate<{ label: string }>('widgets', {
      ...baseFields,
      schemaVersion: 1,
      id: 'wg/abc',
      name: 'a',
    });
    expect(migrated.label).toBe('a');
  });
});

describe('buildMigrationRegistry', () => {
  it('skips collections without migrations', () => {
    const registry = buildMigrationRegistry([widgets, localNotes]);
    expect(Object.keys(registry)).toEqual(['widgets']);
  });
});
