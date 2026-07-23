import { describe, expect, it } from 'vitest';
import { AliasAdapter } from './aliasAdapter';
import { InMemoryAdapter } from './memoryAdapter';
import type { BaseDocument } from '../types';

function mkDoc(id: string): BaseDocument {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'us/1',
    updatedBy: 'us/1',
    deletedAt: null,
    deletedBy: null,
  };
}

const ALIASES = new Map([['widgets', 'c1']]);

describe('AliasAdapter', () => {
  it('stores and reads mapped collections under their physical key', async () => {
    const inner = new InMemoryAdapter();
    const adapter = new AliasAdapter(inner, ALIASES);

    await adapter.put('widgets', mkDoc('w1'));
    await adapter.putMany('widgets', [mkDoc('w2'), mkDoc('w3')]);

    // Physically under the key, invisible under the name.
    expect(await inner.get('c1', 'w1')).not.toBeNull();
    expect(await inner.get('widgets', 'w1')).toBeNull();

    // Reads through the wrapper speak the name.
    expect((await adapter.get('widgets', 'w1'))?.id).toBe('w1');
    expect((await adapter.getMany('widgets', ['w1', 'w2'])).map((d) => d.id)).toEqual(['w1', 'w2']);
    expect(await adapter.getAll('widgets')).toHaveLength(3);

    await adapter.delete('widgets', 'w1');
    expect(await inner.get('c1', 'w1')).toBeNull();
  });

  it('passes unmapped collections (internal _* and strays) through unchanged', async () => {
    const inner = new InMemoryAdapter();
    const adapter = new AliasAdapter(inner, ALIASES);

    await adapter.put('_config', mkDoc('client'));
    expect(await inner.get('_config', 'client')).not.toBeNull();
  });

  it('reverses the mapping in listCollections', async () => {
    const inner = new InMemoryAdapter();
    const adapter = new AliasAdapter(inner, ALIASES);

    await adapter.put('widgets', mkDoc('w1'));
    await adapter.put('_config', mkDoc('client'));
    await inner.put('stale', mkDoc('s1')); // physical row with no alias

    expect((await adapter.listCollections()).sort()).toEqual(['_config', 'stale', 'widgets']);
  });
});
