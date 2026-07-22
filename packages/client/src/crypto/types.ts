/**
 * Pluggable authenticated cipher for document encryption. Injected (like
 * storage adapters) because pact-client runs in environments with different
 * crypto stacks: Workers/Node/web get the WebCrypto implementation from
 * `createWebCryptoCipher`; React Native apps supply one backed by a native
 * module (e.g. react-native-quick-crypto).
 *
 * `aad` is authenticated-but-not-encrypted context (pact binds
 * `<collection>/<id>`), so a sealed payload can't be transplanted onto a
 * different document without failing to open.
 */
export interface DocCipher {
  /** Encrypt `plain`, returning a self-describing envelope string. */
  seal(plain: Uint8Array, aad: string): Promise<string>;
  /** Decrypt an envelope string produced by `seal`. Throws on wrong key, tampering, or AAD mismatch. */
  open(sealed: string, aad: string): Promise<Uint8Array>;
}

/** Envelope strings are versioned and self-identifying: `pactenc$1$<iv>$<ct>`. */
export const ENVELOPE_PREFIX = 'pactenc$';
