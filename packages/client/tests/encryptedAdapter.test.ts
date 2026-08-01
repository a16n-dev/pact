import { describe, it, expect } from 'vitest';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { EncryptedAdapter } from '../src/adapters/encryptedAdapter';
import { createWebCryptoCipher } from '../src/crypto/webCrypto';
import { isEncryptedDoc } from '../src/crypto/docCrypto';
import type { BaseDocument } from '../src/types';

type Widget = BaseDocument & { name: string };

function widget(id: string, name: string): Widget {
  return {
    id,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'us/1',
    updatedBy: 'us/1',
    deletedAt: null,
    deletedBy: null,
    name,
  };
}

function setup() {
  const inner = new InMemoryAdapter();
  const adapter = new EncryptedAdapter(inner, createWebCryptoCipher(new Uint8Array(32).fill(7)));
  return { inner, adapter };
}

describe('EncryptedAdapter', () => {
  it('persists ciphertext but reads back plaintext', async () => {
    const { inner, adapter } = setup();
    await adapter.put('widgets', widget('w1', 'Alpha'));

    const stored = await inner.get<BaseDocument>('widgets', 'w1');
    expect(isEncryptedDoc(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('Alpha');

    expect(await adapter.get<Widget>('widgets', 'w1')).toMatchObject({ id: 'w1', name: 'Alpha' });
    expect(await adapter.getAll<Widget>('widgets')).toHaveLength(1);
    expect((await adapter.getMany<Widget>('widgets', ['w1']))[0]!.name).toBe('Alpha');
  });

  it('passes internal _ collections through unencrypted', async () => {
    const { inner, adapter } = setup();
    const config = { ...widget('client', 'n/a'), token: 'tok-123' };
    await adapter.put('_config', config);
    const stored = await inner.get<BaseDocument>('_config', 'client');
    expect(isEncryptedDoc(stored)).toBe(false);
    expect((stored as typeof config).token).toBe('tok-123');
  });

  it('reads pre-encryption plaintext rows through unchanged', async () => {
    const { inner, adapter } = setup();
    await inner.put('widgets', widget('legacy', 'Old'));
    expect((await adapter.get<Widget>('widgets', 'legacy'))?.name).toBe('Old');
  });

  it('putMany seals every doc', async () => {
    const { inner, adapter } = setup();
    await adapter.putMany!('widgets', [widget('a', 'A'), widget('b', 'B')]);
    for (const doc of await inner.getAll<BaseDocument>('widgets')) {
      expect(isEncryptedDoc(doc)).toBe(true);
    }
    expect((await adapter.getAll<Widget>('widgets')).map((d) => d.name).sort()).toEqual(['A', 'B']);
  });
});
