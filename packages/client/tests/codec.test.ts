import { describe, expect, it } from 'vitest';
import { encryptedCodec, plainCodec } from '../src/crypto/codec';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import { isSealedRecord, type StoredRecord } from '../src/record';

const record: StoredRecord = {
  schemaVersion: 1,
  fields: { id: 'n-1', createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, title: 'hi' },
  clocks: { title: '0000000001000-0000-node' },
};

describe('plainCodec', () => {
  const codec = plainCodec();

  it('stores and ships the record as JSON', async () => {
    const stored = await codec.encode('notes', 'n-1', record);
    expect(stored).toBe(record);
    expect(JSON.parse(codec.toWire(stored))).toEqual(record);
    expect(await codec.fromWire('notes', 'n-1', JSON.stringify(record))).toEqual(record);
  });

  it('treats envelopes and malformed data as unopenable', async () => {
    expect(await codec.fromWire('notes', 'n-1', 'pactenc$1$a$b')).toBeNull();
    expect(await codec.fromWire('notes', 'n-1', 'not json')).toBeNull();
    expect(await codec.fromWire('notes', 'n-1', '{"fields":{}}')).toBeNull();
    await expect(codec.decode('notes', 'n-1', { enc: 'pactenc$1$a$b', hlc: '' })).rejects.toThrow(
      /no cipher/
    );
  });

  it('hides envelopes instead when asked', async () => {
    const hiding = plainCodec({ hideUndecryptable: true });
    expect(await hiding.decode('notes', 'n-1', { enc: 'pactenc$1$a$b', hlc: '' })).toBeNull();
    expect(await hiding.decode('notes', 'n-1', record)).toBe(record);
  });
});

describe('encryptedCodec', () => {
  it('seals at rest, ships the same envelope, and opens only with the right key', async () => {
    const key = await deriveEncryptionKey('pw', 'salt', 1_000);
    const codec = encryptedCodec(createWebCryptoCipher(key));
    const stored = await codec.encode('notes', 'n-1', record);
    if (!isSealedRecord(stored)) throw new Error('expected a sealed record');
    expect(stored.hlc).toBe('0000000001000-0000-node');
    expect(codec.toWire(stored)).toBe(stored.enc);
    expect(await codec.decode('notes', 'n-1', stored)).toEqual(record);
    expect(await codec.fromWire('notes', 'n-1', stored.enc)).toEqual(record);
    expect(await codec.fromWire('notes', 'n-2', stored.enc)).toBeNull();

    const other = encryptedCodec(
      createWebCryptoCipher(await deriveEncryptionKey('x', 'salt', 1_000))
    );
    expect(await other.fromWire('notes', 'n-1', stored.enc)).toBeNull();
    await expect(other.decode('notes', 'n-1', stored)).rejects.toThrow(/Cannot decrypt/);

    const hiding = encryptedCodec(
      createWebCryptoCipher(await deriveEncryptionKey('x', 'salt', 1_000)),
      { hideUndecryptable: true }
    );
    expect(await hiding.decode('notes', 'n-1', stored)).toBeNull();
  });

  it('passes plaintext through on both paths', async () => {
    const key = await deriveEncryptionKey('pw', 'salt', 1_000);
    const codec = encryptedCodec(createWebCryptoCipher(key));
    expect(await codec.decode('notes', 'n-1', record)).toBe(record);
    expect(await codec.fromWire('notes', 'n-1', JSON.stringify(record))).toEqual(record);
  });
});
