import { ENVELOPE_PREFIX, type DocCipher } from './types';
import { toBase64, fromBase64 } from './base64';

// AES-256-GCM over WebCrypto (globalThis.crypto.subtle) — present natively in
// Workers, Node ≥ 19, and every modern browser. React Native lacks it; RN
// apps inject their own DocCipher instead of using this factory.

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;

/**
 * Build a DocCipher from a raw 256-bit key. Get a key from
 * `deriveEncryptionKey` (passphrase) or your platform keychain.
 */
export function createWebCryptoCipher(rawKey: Uint8Array): DocCipher {
  if (rawKey.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (AES-256)');
  }
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = () =>
    (keyPromise ??= crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]));
  const encoder = new TextEncoder();

  return {
    async seal(plain: Uint8Array, aad: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
          await getKey(),
          plain as BufferSource
        )
      );
      return `${ENVELOPE_PREFIX}${ENVELOPE_VERSION}$${toBase64(iv)}$${toBase64(ct)}`;
    },

    async open(sealed: string, aad: string): Promise<Uint8Array> {
      const parts = sealed.split('$');
      if (parts.length !== 4 || `${parts[0]}$` !== ENVELOPE_PREFIX) {
        throw new Error('Not a pact encryption envelope');
      }
      if (Number(parts[1]) !== ENVELOPE_VERSION) {
        throw new Error(`Unsupported envelope version: ${parts[1]}`);
      }
      const iv = fromBase64(parts[2]!);
      const ct = fromBase64(parts[3]!);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(aad) },
        await getKey(),
        ct as BufferSource
      );
      return new Uint8Array(plain);
    },
  };
}

/**
 * Derive a 256-bit encryption key from a human passphrase (PBKDF2-SHA-256).
 * The salt need not be secret but must be stable per app group — e.g. the
 * appName — so every member device derives the same key.
 */
export async function deriveEncryptionKey(
  passphrase: string,
  salt: string | Uint8Array,
  iterations = 210_000
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const saltBytes = typeof salt === 'string' ? encoder.encode(salt) : salt;
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes as BufferSource, iterations },
    material,
    256
  );
  return new Uint8Array(bits);
}
