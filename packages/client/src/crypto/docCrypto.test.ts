import { describe, it, expect } from 'vitest';
import { createWebCryptoCipher, deriveEncryptionKey } from './webCrypto';
import { encryptDoc, decryptDoc, isEncryptedDoc } from './docCrypto';
import type { BaseDocument } from '../types';

type Widget = BaseDocument & { name: string; secret: { nested: number } };

const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

function widget(id = 'w1'): Widget {
  return {
    id,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdBy: 'us/1',
    updatedBy: 'us/1',
    deletedAt: null,
    deletedBy: null,
    name: 'Alpha',
    secret: { nested: 42 },
  };
}

describe('encryptDoc / decryptDoc', () => {
  const cipher = createWebCryptoCipher(KEY_A);

  it('round-trips a doc, keeping base fields cleartext and domain fields sealed', async () => {
    const sealed = await encryptDoc(cipher, 'widgets', widget());
    // Base fields visible, domain fields gone, envelope present.
    expect(sealed.id).toBe('w1');
    expect(sealed.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(sealed.enc).toMatch(/^pactenc\$1\$/);
    expect(isEncryptedDoc(sealed)).toBe(true);
    const raw = JSON.stringify(sealed);
    expect(raw).not.toContain('Alpha');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('42');

    const opened = await decryptDoc<Widget>(cipher, 'widgets', sealed);
    expect(opened).toEqual(widget());
  });

  it('never double-wraps an already encrypted doc', async () => {
    const once = await encryptDoc(cipher, 'widgets', widget());
    const twice = await encryptDoc(cipher, 'widgets', once);
    expect(twice).toBe(once);
  });

  it('passes plaintext docs through decrypt untouched (mixed-history stores)', async () => {
    const doc = widget();
    expect(await decryptDoc<Widget>(cipher, 'widgets', doc)).toBe(doc);
  });

  it('fails to open with the wrong key', async () => {
    const sealed = await encryptDoc(cipher, 'widgets', widget());
    const wrong = createWebCryptoCipher(KEY_B);
    await expect(decryptDoc(wrong, 'widgets', sealed)).rejects.toThrow();
  });

  it('rejects an envelope transplanted onto another doc or collection (AAD binding)', async () => {
    const sealed = await encryptDoc(cipher, 'widgets', widget('w1'));
    const transplantedId = { ...sealed, id: 'w2' };
    await expect(decryptDoc(cipher, 'widgets', transplantedId)).rejects.toThrow();
    await expect(decryptDoc(cipher, 'gadgets', sealed)).rejects.toThrow();
  });
});

describe('deriveEncryptionKey', () => {
  it('derives a stable 32-byte key per passphrase+salt, distinct across salts', async () => {
    const a1 = await deriveEncryptionKey('open sesame', 'myapp', 1000);
    const a2 = await deriveEncryptionKey('open sesame', 'myapp', 1000);
    const b = await deriveEncryptionKey('open sesame', 'otherapp', 1000);
    expect(a1).toHaveLength(32);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });
});
