import { z } from 'zod';

// The server treats document data as opaque. These helpers read it the way @a16n/pact-client
// writes it (`StoredRecord` in client-2/src/record.ts, `encodeHlc` in client-2/src/clock.ts) so
// the admin pages can show it, and fall back to the raw string for anything else.

const ENVELOPE_PREFIX = 'pactenc$';
const CLOCK_PATTERN = /^(\d{13})-[0-9a-f]{4}-(.+)$/;

type ParsedClock = { raw: string; wallMs: number; node: string };

export function parseClock(raw: string): ParsedClock | null {
  const match = CLOCK_PATTERN.exec(raw);
  return match ? { raw, wallMs: Number(match[1]), node: match[2]! } : null;
}

const recordSchema = z.object({
  schemaVersion: z.number(),
  fields: z.record(z.string(), z.unknown()),
  clocks: z.record(z.string(), z.string()).optional(),
  clock: z.string().optional(),
  text: z.string().optional(),
});

export type DecodedRecord = z.infer<typeof recordSchema>;

export type DecodedData =
  | { kind: 'record'; record: DecodedRecord }
  | { kind: 'encrypted' }
  | { kind: 'json'; value: unknown }
  | { kind: 'opaque' };

export function decodeData(data: string): DecodedData {
  if (data.startsWith(ENVELOPE_PREFIX)) return { kind: 'encrypted' };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: 'opaque' };
  }
  const record = recordSchema.safeParse(value);
  return record.success ? { kind: 'record', record: record.data } : { kind: 'json', value };
}

export type FieldValue = { name: string; value: unknown; clock?: string };

// A field with a clock but no value was unset by that write, so it shows with `value` undefined.
export function recordFields(record: DecodedRecord): FieldValue[] {
  const names = new Set([...Object.keys(record.fields), ...Object.keys(record.clocks ?? {})]);
  return [...names].map((name) => ({
    name,
    value: record.fields[name],
    clock: record.clocks?.[name],
  }));
}

type MergedRecord = {
  mode: 'field' | 'document';
  schemaVersion: number;
  clock?: string;
  fields: FieldValue[];
};

// Mirrors the client's merge closely enough to show the value devices converge on; text fields
// are Yjs state and are not merged here.
export function mergeRecords(records: DecodedRecord[]): MergedRecord | null {
  if (records.length === 0) return null;
  const schemaVersion = Math.max(...records.map((record) => record.schemaVersion));
  if (records.every((record) => record.clock !== undefined)) {
    const winner = records.reduce((a, b) => (b.clock! > a.clock! ? b : a));
    return {
      mode: 'document',
      schemaVersion,
      clock: winner.clock,
      fields: recordFields({ ...winner, clocks: undefined }),
    };
  }
  const fields = new Map<string, FieldValue>();
  for (const record of records) {
    for (const field of recordFields(record)) {
      const current = fields.get(field.name);
      const newer = !current || (field.clock !== undefined && (current.clock ?? '') < field.clock);
      if (newer) fields.set(field.name, field);
    }
  }
  return { mode: 'field', schemaVersion, fields: [...fields.values()] };
}
