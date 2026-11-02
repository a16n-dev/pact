/**
 * Injected rather than built in because runtimes differ: Workers, Node, and
 * browsers use `createWebCryptoCipher`; React Native supplies one backed by a
 * native module. `aad` is AES-GCM additional authenticated data: context the
 * cipher signs but does not encrypt. Pact passes `<collection>/<id>`, so a
 * sealed payload moved onto another document fails to open.
 */
export type DocCipher = {
  seal(plain: Uint8Array, aad: string): Promise<string>;
  /** Throws on a wrong key, tampering, or an AAD mismatch. */
  open(sealed: string, aad: string): Promise<Uint8Array>;
  /**
   * 16 lowercase hex characters naming the key's lens, the same on every
   * device that holds the key. The server sees it in collection keys, so it
   * must not reveal the key: `createWebCryptoCipher` takes the first 8 bytes
   * of SHA-256 over `pact-key-id:` followed by the raw key.
   */
  keyId(): Promise<string>;
};

/** Envelopes are versioned and self-identifying: `pactenc$1$<iv>$<ct>`. */
export const ENVELOPE_PREFIX = 'pactenc$';
