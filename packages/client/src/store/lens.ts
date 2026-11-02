import { encryptedCodec, plainCodec, type RecordCodec } from '../crypto/codec';
import type { DocCipher } from '../crypto/types';

const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

/** `@` plus a key id, appended to a collection key or task key inside a lens. */
export const LENS_SUFFIX_LENGTH = 17;

/** The documents a store shows: those sealed under one key, or the plain ones when `keyId` is null. */
export type Lens = { keyId: string | null; codec: RecordCodec };

export async function lensFor(cipher: DocCipher | null): Promise<Lens> {
  if (!cipher) return { keyId: null, codec: plainCodec() };
  const keyId = await cipher.keyId();
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`DocCipher.keyId must return 16 lowercase hex characters, got "${keyId}"`);
  }
  return { keyId, codec: encryptedCodec(cipher) };
}

// Collection keys may not contain `@`, so the suffix parses unambiguously.
export function lensKey(key: string, keyId: string | null): string {
  return keyId ? `${key}@${keyId}` : key;
}

export function parseLensKey(storageKey: string): { key: string; keyId: string | null } {
  const at = storageKey.lastIndexOf('@');
  if (at === -1) return { key: storageKey, keyId: null };
  return { key: storageKey.slice(0, at), keyId: storageKey.slice(at + 1) };
}
