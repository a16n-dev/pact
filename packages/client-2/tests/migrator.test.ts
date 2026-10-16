import { describe, expect, it } from 'vitest';
import { Migrator, defineCollectionMigrations } from '../src/migrator';

const migrator = new Migrator({
  notes: defineCollectionMigrations({
    current: 3,
    migrations: [
      { from: 1, to: 2, up: (f) => ({ ...f, title: f.name }) },
      { from: 2, to: 3, up: (f) => ({ ...f, title: `${f.title}!` }) },
    ],
  }),
});

describe('Migrator', () => {
  it('walks the chain from the stored version to current', () => {
    expect(migrator.migrate('notes', 1, { id: 'n-1', name: 'hi' })).toEqual({
      id: 'n-1',
      name: 'hi',
      title: 'hi!',
    });
    expect(migrator.migrate('notes', 3, { id: 'n-1', title: 'x' })).toEqual({
      id: 'n-1',
      title: 'x',
    });
  });

  it('leaves unknown collections alone at version 1', () => {
    expect(migrator.currentVersion('other')).toBe(1);
    expect(migrator.migrate('other', 1, { id: 'o-1' })).toEqual({ id: 'o-1' });
  });

  it('refuses versions newer than the build and gaps in the chain', () => {
    expect(() => migrator.migrate('notes', 4, { id: 'n-1' })).toThrow(/Upgrade the app/);
    const gappy = new Migrator({
      notes: { current: 3, migrations: [{ from: 2, to: 3, up: (f) => f }] },
    });
    expect(() => gappy.migrate('notes', 1, { id: 'n-1' })).toThrow(/incomplete/);
  });
});
