import type { BaseDocument } from '../types';
import { ENVELOPE_PREFIX, type DocCipher } from './types';

/**
 * A document whose domain fields have been folded into one sealed string.
 * This single shape is both what an encrypted Store persists locally and
 * what goes over the sync wire — the base sync/audit fields stay cleartext
 * (LWW merge, author reassignment, and audit need them), everything else is
 * ciphertext.
 */
export type EncryptedDoc = BaseDocument & { enc: string };

/**
 * The BaseDocument fields that stay cleartext on an encrypted doc. Everything
 * NOT in this set is a domain field and gets sealed.
 */
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

/** Authenticated context binding an envelope to its document identity. */
function aadFor(collection: string, id: string): string {
  return `${collection}/${id}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Seal a doc's domain fields into an `enc` envelope, keeping base fields
 * cleartext. Already-encrypted docs pass through unchanged (never
 * double-wrapped — e.g. a raw envelope being re-put during a restore).
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
 * Open an encrypted doc back into its plaintext shape. Non-envelope docs pass
 * through unchanged, so stores with mixed plaintext/encrypted history (or
 * encryption newly enabled) read cleanly. Throws on a wrong key or a
 * tampered/transplanted envelope.
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
