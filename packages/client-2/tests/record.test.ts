import { describe, expect, it } from 'vitest';
import { encodeHlc } from '../src/clock';
import { greatestClock, mergeRecords, updatedAtOf, type StoredRecord } from '../src/record';

const at = (wallMs: number, node = 'a') => encodeHlc({ wallMs, counter: 0, node });

function fieldRecord(
  fields: Record<string, unknown>,
  clocks: Record<string, string>,
  extra: Partial<StoredRecord> = {}
): StoredRecord {
  return {
    schemaVersion: 1,
    fields: { id: 'n-1', createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...fields },
    clocks,
    ...extra,
  };
}

describe('mergeRecords by field', () => {
  it('takes each field from the side with the greater clock', () => {
    const local = fieldRecord(
      { title: 'A', body: 'x' },
      { title: at(5), body: at(1), deletedAt: at(1) }
    );
    const incoming = fieldRecord(
      { title: 'B', body: 'y' },
      { title: at(3), body: at(9), deletedAt: at(1) }
    );
    const { record, changed } = mergeRecords(local, incoming, 'field');
    expect(changed).toBe(true);
    expect(record.fields).toMatchObject({ title: 'A', body: 'y' });
    expect(record.clocks).toEqual({ title: at(5), body: at(9), deletedAt: at(1) });
  });

  it('is commutative and idempotent', () => {
    const local = fieldRecord({ title: 'A', tags: ['x'] }, { title: at(5), tags: at(2) });
    const incoming = fieldRecord({ title: 'B', tags: ['y'] }, { title: at(3), tags: at(4) });
    const ab = mergeRecords(local, incoming, 'field').record;
    const ba = mergeRecords(incoming, local, 'field').record;
    expect(ab).toEqual(ba);
    const again = mergeRecords(ab, incoming, 'field');
    expect(again.changed).toBe(false);
    expect(again.record).toEqual(ab);
  });

  it('reports no change when the incoming record is older everywhere', () => {
    const local = fieldRecord({ title: 'A' }, { title: at(5) });
    const incoming = fieldRecord({ title: 'B' }, { title: at(3) });
    expect(mergeRecords(local, incoming, 'field').changed).toBe(false);
  });

  it('resolves delete and undelete by clock', () => {
    const local = fieldRecord({ deletedAt: '2026-01-02T00:00:00.000Z' }, { deletedAt: at(5) });
    const undeleted = fieldRecord({ deletedAt: null }, { deletedAt: at(6) });
    expect(mergeRecords(local, undeleted, 'field').record.fields.deletedAt).toBeNull();
    const older = fieldRecord({ deletedAt: null }, { deletedAt: at(4) });
    expect(mergeRecords(local, older, 'field').record.fields.deletedAt).toBe(
      '2026-01-02T00:00:00.000Z'
    );
  });

  it('keeps the earlier createdAt and the greater schemaVersion', () => {
    const local = fieldRecord({}, {});
    local.fields.createdAt = '2026-01-05T00:00:00.000Z';
    const incoming = fieldRecord({}, {});
    incoming.schemaVersion = 2;
    const { record } = mergeRecords(local, incoming, 'field');
    expect(record.fields.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(record.schemaVersion).toBe(2);
  });

  it('removes a field the newer side dropped', () => {
    const local = fieldRecord({ note: 'keep' }, { note: at(1) });
    const incoming = fieldRecord({}, { note: at(2) });
    const { record } = mergeRecords(local, incoming, 'field');
    expect('note' in record.fields).toBe(false);
    expect(record.clocks?.note).toBe(at(2));
  });

  it('merges text through the supplied merge and leaves plain fields alone', () => {
    const local = fieldRecord({}, { body: at(1) }, { text: 'L' });
    const incoming = fieldRecord({}, { body: at(2) }, { text: 'R' });
    const { record } = mergeRecords(local, incoming, 'field', (a, b) => `${a}+${b}`);
    expect(record.text).toBe('L+R');
    expect(record.clocks?.body).toBe(at(2));
    expect(() => mergeRecords(local, incoming, 'field')).toThrow(/text merge/);
  });
});

describe('mergeRecords immutable', () => {
  const doc = (fields: Record<string, unknown>, clock: string): StoredRecord => ({
    schemaVersion: 1,
    fields: { id: 'e-1', createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...fields },
    clock,
  });

  it('keeps the first write and the greatest clock', () => {
    const local = doc({ x: 1 }, at(5));
    const incoming = doc({ x: 2 }, at(6));
    expect(mergeRecords(local, incoming, 'immutable').record).toEqual({
      ...local,
      clock: at(6),
    });
    expect(mergeRecords(incoming, local, 'immutable').record).toEqual({
      ...local,
      clock: at(6),
    });
  });

  it('lets a delete stick regardless of clock order', () => {
    const live = doc({ x: 1 }, at(9));
    const deleted = doc({ x: 1, deletedAt: '2026-01-02T00:00:00.000Z' }, at(5));
    const { record, changed } = mergeRecords(live, deleted, 'immutable');
    expect(changed).toBe(true);
    expect(record.fields.deletedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(mergeRecords(deleted, live, 'immutable').record.fields.deletedAt).toBe(
      '2026-01-02T00:00:00.000Z'
    );
  });

  it('keeps the earliest of two deletions', () => {
    const a = doc({ deletedAt: '2026-01-03T00:00:00.000Z' }, at(5));
    const b = doc({ deletedAt: '2026-01-02T00:00:00.000Z' }, at(6));
    expect(mergeRecords(a, b, 'immutable').record.fields.deletedAt).toBe(
      '2026-01-02T00:00:00.000Z'
    );
  });
});

describe('mergeRecords by document', () => {
  const doc = (fields: Record<string, unknown>, clock: string): StoredRecord => ({
    schemaVersion: 1,
    fields: { id: 'c-1', createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...fields },
    clock,
  });

  it('takes the record with the greater clock wholesale', () => {
    const local = doc({ x: 1, y: 1 }, at(5));
    const incoming = doc({ x: 2 }, at(6));
    const { record, changed } = mergeRecords(local, incoming, 'document');
    expect(changed).toBe(true);
    expect(record.fields).toEqual({ ...incoming.fields });
    expect(record.clock).toBe(at(6));
    expect(mergeRecords(incoming, local, 'document').record).toEqual(record);
  });

  it('keeps the local record when it is newer', () => {
    const local = doc({ x: 1 }, at(7));
    const result = mergeRecords(local, doc({ x: 2 }, at(6)), 'document');
    expect(result.changed).toBe(false);
    expect(result.record.fields.x).toBe(1);
  });
});

describe('updatedAt derivation', () => {
  it('uses the greatest clock across fields, and createdAt when there is none', () => {
    const record = fieldRecord({}, { a: at(1_000), b: at(5_000) });
    expect(greatestClock(record)).toBe(at(5_000));
    expect(updatedAtOf(record)).toBe('1970-01-01T00:00:05.000Z');
    expect(updatedAtOf(fieldRecord({}, {}))).toBe('2026-01-01T00:00:00.000Z');
  });
});
