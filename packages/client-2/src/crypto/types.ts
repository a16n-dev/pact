/**
 * Injected rather than built in because runtimes differ: Workers, Node, and
 * browsers use `createWebCryptoCipher`; React Native supplies one backed by a
 * native module. `aad` is authenticated but not encrypted context (pact binds
 * `<collection>/<id>`), so a sealed payload cannot be moved to another
 * document without failing to open.
 */
export type DocCipher = {
  seal(plain: Uint8Array, aad: string): Promise<string>;
  /** Throws on a wrong key, tampering, or an AAD mismatch. */
  open(sealed: string, aad: string): Promise<Uint8Array>;
};

/** Envelopes are versioned and self-identifying: `pactenc$1$<iv>$<ct>`. */
export const ENVELOPE_PREFIX = 'pactenc$';
