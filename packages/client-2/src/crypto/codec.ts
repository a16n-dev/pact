import {
  StoredRecordSchema,
  greatestClock,
  isSealedRecord,
  type AdapterRecord,
  type StoredRecord,
} from '../record';
import { ENVELOPE_PREFIX, type DocCipher } from './types';

/**
 * Translates between the store's record and what the adapter holds and the
 * wire carries. An encrypted store keeps the wire envelope at rest, so a
 * push sends the stored ciphertext as-is and never re-seals.
 */
export type RecordCodec = {
  encode(collection: string, id: string, record: StoredRecord): Promise<AdapterRecord>;
  decode(collection: string, id: string, stored: AdapterRecord): Promise<StoredRecord>;
  toWire(stored: AdapterRecord): string;
  /** Null when the data is an envelope this store cannot open, or is not a record at all. */
  fromWire(collection: string, id: string, data: string): Promise<StoredRecord | null>;
};

// Additional authenticated data for the cipher. Binding the envelope to the
// collection and id means a ciphertext moved onto a different document fails
// to open.
function aadFor(collection: string, id: string): string {
  return `${collection}/${id}`;
}

function parseRecord(json: string): StoredRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = StoredRecordSchema.safeParse(parsed);
  return result.success ? (result.data as StoredRecord) : null;
}

export function plainCodec(): RecordCodec {
  return {
    async encode(_collection, _id, record) {
      return record;
    },
    async decode(collection, id, stored) {
      if (isSealedRecord(stored)) {
        throw new Error(`${collection}/${id} is encrypted but the store has no cipher`);
      }
      return stored;
    },
    toWire(stored) {
      return isSealedRecord(stored) ? stored.enc : JSON.stringify(stored);
    },
    async fromWire(_collection, _id, data) {
      return data.startsWith(ENVELOPE_PREFIX) ? null : parseRecord(data);
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encryptedCodec(cipher: DocCipher): RecordCodec {
  const open = async (
    collection: string,
    id: string,
    enc: string
  ): Promise<StoredRecord | null> => {
    let plain: Uint8Array;
    try {
      plain = await cipher.open(enc, aadFor(collection, id));
    } catch {
      return null;
    }
    return parseRecord(decoder.decode(plain));
  };
  return {
    async encode(collection, id, record) {
      const json = JSON.stringify(record);
      const enc = await cipher.seal(encoder.encode(json), aadFor(collection, id));
      return { enc, hlc: greatestClock(record) ?? '' };
    },
    // Plaintext rows from before encryption was enabled pass through until
    // `encryptLocal()` rewrites them.
    async decode(collection, id, stored) {
      if (!isSealedRecord(stored)) return stored;
      const record = await open(collection, id, stored.enc);
      if (!record) throw new Error(`Cannot decrypt ${collection}/${id} with this key`);
      return record;
    },
    toWire(stored) {
      return isSealedRecord(stored) ? stored.enc : JSON.stringify(stored);
    },
    // Plaintext is accepted so a store can adopt encryption after data exists on the server.
    async fromWire(collection, id, data) {
      return data.startsWith(ENVELOPE_PREFIX) ? open(collection, id, data) : parseRecord(data);
    },
  };
}
