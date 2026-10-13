import { describe, expect, it } from 'vitest';
import { compareSiblings, foldSiblings, type SiblingRow } from '../src/sync/fold';

type Row = SiblingRow & { name: string };

function row(id: string, name: string, updatedAt: string, clientId?: string): Row {
  return { id, collection: 'c', updatedAt, clientId, name };
}

describe('foldSiblings', () => {
  it('keeps the later updatedAt among siblings of one document', () => {
    const out = foldSiblings([
      row('a', 'old', '2026-01-01T00:00:00.000Z', 'cl-1'),
      row('a', 'new', '2026-02-01T00:00:00.000Z', 'cl-2'),
      row('a', 'mid', '2026-01-15T00:00:00.000Z', 'cl-3'),
    ]);
    expect(out.map((r) => r.name)).toEqual(['new']);
  });

  it('breaks an exact timestamp tie on clientId, regardless of arrival order', () => {
    const t = '2026-05-05T00:00:00.000Z';
    const forward = foldSiblings([row('a', 'from-1', t, 'cl-1'), row('a', 'from-2', t, 'cl-2')]);
    const reverse = foldSiblings([row('a', 'from-2', t, 'cl-2'), row('a', 'from-1', t, 'cl-1')]);
    expect(forward[0].name).toBe('from-2');
    expect(reverse[0].name).toBe('from-2');
  });

  it('keys on collection + id, preserving first-seen order of documents', () => {
    const out = foldSiblings([
      row('b', 'b', '2026-01-01T00:00:00.000Z', 'cl-1'),
      row('a', 'a1', '2026-01-01T00:00:00.000Z', 'cl-1'),
      { ...row('a', 'other-collection', '2026-03-01T00:00:00.000Z', 'cl-1'), collection: 'd' },
      row('a', 'a2', '2026-01-02T00:00:00.000Z', 'cl-2'),
    ]);
    expect(out.map((r) => `${r.collection}/${r.id}:${r.name}`)).toEqual([
      'c/b:b',
      'c/a:a2',
      'd/a:other-collection',
    ]);
  });

  it('treats a row without clientId as the lowest tiebreak', () => {
    const t = '2026-05-05T00:00:00.000Z';
    expect(compareSiblings(row('a', 'x', t), row('a', 'y', t, 'cl-1'))).toBeLessThan(0);
  });
});
