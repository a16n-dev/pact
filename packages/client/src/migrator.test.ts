import { describe, it, expect } from 'vitest';
import { Migrator, noopMigrator, type MigrationRegistry } from './migrator';

const registry: MigrationRegistry = {
  widgets: {
    current: 3,
    migrations: [
      { from: 1, to: 2, up: (d) => ({ ...d, two: true }) },
      { from: 2, to: 3, up: (d) => ({ ...d, three: true }) },
    ],
  },
};

describe('Migrator', () => {
  const m = new Migrator(registry);

  it('reports the current version, or 1 for unknown collections', () => {
    expect(m.currentVersion('widgets')).toBe(3);
    expect(m.currentVersion('unknown')).toBe(1);
  });

  it('passes through unknown collections unchanged (same reference)', () => {
    const doc = { id: 'x', schemaVersion: 1 };
    expect(m.migrate('unknown', doc)).toBe(doc);
  });

  it('walks the chain and stamps the current version', () => {
    const out = m.migrate<{ schemaVersion: number; two?: boolean; three?: boolean }>('widgets', {
      id: 'w1',
      schemaVersion: 1,
    });
    expect(out.two).toBe(true);
    expect(out.three).toBe(true);
    expect(out.schemaVersion).toBe(3);
  });

  it('treats a missing schemaVersion as 1', () => {
    const out = m.migrate<{ schemaVersion: number; two?: boolean }>('widgets', { id: 'w1' });
    expect(out.two).toBe(true);
    expect(out.schemaVersion).toBe(3);
  });

  it('throws when the doc is newer than this build knows', () => {
    expect(() => m.migrate('widgets', { id: 'w1', schemaVersion: 4 })).toThrow(/Upgrade the app/);
  });

  it('throws when the migration chain has a gap', () => {
    const gapped = new Migrator({
      widgets: { current: 3, migrations: [{ from: 1, to: 2, up: (d) => d }] },
    });
    expect(() => gapped.migrate('widgets', { id: 'w1', schemaVersion: 2 })).toThrow(/No migrator/);
  });

  it('needsMigration reflects whether the doc is behind current', () => {
    expect(m.needsMigration('widgets', { schemaVersion: 1 })).toBe(true);
    expect(m.needsMigration('widgets', { schemaVersion: 3 })).toBe(false);
    expect(m.needsMigration('unknown', { schemaVersion: 1 })).toBe(false);
  });

  it('noopMigrator passes docs through at version 1', () => {
    const doc = { id: 'x', schemaVersion: 1 };
    expect(noopMigrator.currentVersion('anything')).toBe(1);
    expect(noopMigrator.migrate('anything', doc)).toBe(doc);
  });
});
