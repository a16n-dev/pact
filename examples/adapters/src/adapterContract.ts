import { describe, it, expect } from 'vitest';
import type { BaseDocument, DatabaseAdapter } from '@a16n/pact-client';

type Widget = BaseDocument & { name: string };

function mkDoc(id: string, name: string): Widget {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: 'us-test',
    updatedBy: 'us-test',
    deletedAt: null,
    deletedBy: null,
    name,
  };
}

/**
 * The behavior every `DatabaseAdapter` must have, as a reusable vitest
 * suite. Point it at a factory for your adapter and you've tested the
 * contract the `Store` relies on. Note what is NOT here: adapters never
 * filter tombstones, never validate, never migrate — they store documents
 * verbatim and the Store does the rest.
 */
export function describeAdapterContract(
  name: string,
  factory: () => Promise<{ adapter: DatabaseAdapter; cleanup?: () => void | Promise<void> }>
): void {
  describe(`${name}: DatabaseAdapter contract`, () => {
    async function withAdapter(run: (adapter: DatabaseAdapter) => Promise<void>): Promise<void> {
      const { adapter, cleanup } = await factory();
      try {
        await run(adapter);
      } finally {
        await cleanup?.();
      }
    }

    it('returns null for a missing doc and [] for a missing collection', () =>
      withAdapter(async (adapter) => {
        expect(await adapter.get('widgets', 'nope')).toBeNull();
        expect(await adapter.getAll('widgets')).toEqual([]);
        expect(await adapter.getMany('widgets', ['nope'])).toEqual([]);
      }));

    it('round-trips a document and upserts on repeated put', () =>
      withAdapter(async (adapter) => {
        await adapter.put('widgets', mkDoc('w1', 'Alpha'));
        expect(await adapter.get<Widget>('widgets', 'w1')).toMatchObject({ name: 'Alpha' });
        await adapter.put('widgets', mkDoc('w1', 'Alpha v2'));
        expect(await adapter.get<Widget>('widgets', 'w1')).toMatchObject({ name: 'Alpha v2' });
        expect(await adapter.getAll('widgets')).toHaveLength(1);
      }));

    it('stores tombstones verbatim — the adapter never filters deleted docs', () =>
      withAdapter(async (adapter) => {
        const tombstone = {
          ...mkDoc('w1', 'Gone'),
          deletedAt: '2026-02-01T00:00:00.000Z',
          deletedBy: 'us-test',
        };
        await adapter.put('widgets', tombstone);
        expect(await adapter.get<Widget>('widgets', 'w1')).toMatchObject({
          deletedAt: '2026-02-01T00:00:00.000Z',
        });
        expect(await adapter.getAll('widgets')).toHaveLength(1);
      }));

    it('getMany returns present docs and skips missing ids', () =>
      withAdapter(async (adapter) => {
        await adapter.put('widgets', mkDoc('w1', 'Alpha'));
        await adapter.put('widgets', mkDoc('w2', 'Beta'));
        const docs = await adapter.getMany<Widget>('widgets', ['w1', 'missing', 'w2']);
        expect(docs.map((d) => d.name).sort()).toEqual(['Alpha', 'Beta']);
      }));

    it('keeps collections separate', () =>
      withAdapter(async (adapter) => {
        await adapter.put('widgets', mkDoc('w1', 'Widget'));
        await adapter.put('gadgets', mkDoc('w1', 'Gadget'));
        expect(await adapter.get<Widget>('widgets', 'w1')).toMatchObject({ name: 'Widget' });
        expect(await adapter.get<Widget>('gadgets', 'w1')).toMatchObject({ name: 'Gadget' });
        expect((await adapter.listCollections()).sort()).toEqual(['gadgets', 'widgets']);
      }));

    it('delete removes one doc; deleting a missing doc is a no-op', () =>
      withAdapter(async (adapter) => {
        await adapter.put('widgets', mkDoc('w1', 'Alpha'));
        await adapter.put('widgets', mkDoc('w2', 'Beta'));
        await adapter.delete('widgets', 'w1');
        await adapter.delete('widgets', 'never-existed');
        expect(await adapter.get('widgets', 'w1')).toBeNull();
        expect(await adapter.getAll('widgets')).toHaveLength(1);
      }));

    it('putMany (when implemented) writes the whole batch', () =>
      withAdapter(async (adapter) => {
        if (!adapter.putMany) return;
        await adapter.putMany('widgets', [mkDoc('w1', 'A'), mkDoc('w2', 'B'), mkDoc('w3', 'C')]);
        expect(await adapter.getAll('widgets')).toHaveLength(3);
      }));

    it('wipe clears every collection', () =>
      withAdapter(async (adapter) => {
        await adapter.put('widgets', mkDoc('w1', 'Alpha'));
        await adapter.put('_config', mkDoc('client', 'internal'));
        await adapter.wipe();
        expect(await adapter.getAll('widgets')).toEqual([]);
        expect(await adapter.listCollections()).toEqual([]);
      }));
  });
}
