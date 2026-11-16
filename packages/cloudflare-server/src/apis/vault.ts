import type { Env } from '../lib/env';
import { ApiError } from '../lib/errors';
import { base64url, fromBase64url } from '../lib/crypto';

const IV_BYTES = 12;

async function vaultKey(env: Env): Promise<CryptoKey> {
  if (!env.VAULT_KEY) {
    throw new ApiError(503, 'api_not_configured', 'This server has no VAULT_KEY configured');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.VAULT_KEY));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// `context` is bound in as additional data, so a sealed value copied into another app's or
// API's row fails to open.
export async function seal(env: Env, context: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
    await vaultKey(env),
    new TextEncoder().encode(plaintext)
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return base64url(out);
}

export async function unseal(env: Env, context: string, sealed: string): Promise<string> {
  const bytes = fromBase64url(sealed);
  const key = await vaultKey(env);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(0, IV_BYTES),
        additionalData: new TextEncoder().encode(context),
      },
      key,
      bytes.slice(IV_BYTES)
    );
  } catch {
    throw new ApiError(
      503,
      'api_not_configured',
      'The stored credentials no longer open; VAULT_KEY may have changed'
    );
  }
  return new TextDecoder().decode(plaintext);
}
