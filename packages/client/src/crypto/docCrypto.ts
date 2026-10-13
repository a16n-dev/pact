import type { BaseDocument } from '../types';
import { ENVELOPE_PREFIX, type DocCipher } from './types';

/**
 * The one shape an encrypted Store both persists locally and sends over the
 * wire. Base fields stay cleartext because LWW merge, author reassignment,
 * and audit need them; every other field is inside `enc`.
 */
export type EncryptedDoc = BaseDocument & { enc: string };

// Must match the keys of `BaseDocumentSchema`; anything else is sealed.
const BASE_FIELDS = new Set([
  'id',
  'schemaVersion',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'deletedAt',
  'deletedBy',
]);

export function isEncryptedDoc(doc: unknown): doc is EncryptedDoc {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    typeof (doc as { enc?: unknown }).enc === 'string' &&
    (doc as { enc: string }).enc.startsWith(ENVELOPE_PREFIX)
  );
}

// Binding the envelope to collection and id means a ciphertext moved onto a
// different document fails to open.
function aadFor(collection: string, id: string): string {
  return `${collection}/${id}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * An already-sealed doc is returned as is rather than double-wrapped, which
 * is what lets a restore re-put raw envelopes.
 */
export async function encryptDoc<T extends BaseDocument>(
  cipher: DocCipher,
  collection: string,
  doc: T
): Promise<EncryptedDoc> {
  if (isEncryptedDoc(doc)) return doc;
  const base = {} as Record<string, unknown>;
  const domain = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(doc)) {
    if (BASE_FIELDS.has(key)) base[key] = value;
    else domain[key] = value;
  }
  const enc = await cipher.seal(encoder.encode(JSON.stringify(domain)), aadFor(collection, doc.id));
  return { ...(base as BaseDocument), enc };
}

/**
 * A non-envelope doc is returned unchanged, so a store with mixed plaintext
 * and encrypted history reads cleanly. Throws on a wrong key or a tampered or
 * transplanted envelope.
 */
export async function decryptDoc<T extends BaseDocument>(
  cipher: DocCipher,
  collection: string,
  doc: BaseDocument
): Promise<T> {
  if (!isEncryptedDoc(doc)) return doc as T;
  const { enc, ...base } = doc;
  const plain = await cipher.open(enc, aadFor(collection, doc.id));
  const domain = JSON.parse(decoder.decode(plain)) as Record<string, unknown>;
  return { ...domain, ...base } as T;
}

/**
 * Like `decryptDoc`, but an envelope this cipher cannot open yields `null`
 * (the `onUndecryptable: 'hide'` path). AES-GCM cannot tell a wrong key from
 * tampering, so both hide; a JSON parse failure after authentication is real
 * corruption and still throws.
 */
export async function tryDecryptDoc<T extends BaseDocument>(
  cipher: DocCipher,
  collection: string,
  doc: BaseDocument
): Promise<T | null> {
  if (!isEncryptedDoc(doc)) return doc as T;
  const { enc, ...base } = doc;
  let plain: Uint8Array;
  try {
    plain = await cipher.open(enc, aadFor(collection, doc.id));
  } catch {
    return null;
  }
  const domain = JSON.parse(decoder.decode(plain)) as Record<string, unknown>;
  return { ...domain, ...base } as T;
}
