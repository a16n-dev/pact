import { describe, expect, it } from 'vitest';
import { compareSiblings, foldSiblings, type PulledDocument } from '../src/sync/fold';
import type { BaseDocument } from '../src/types';

type Doc = BaseDocument & { name: string };

function row(id: string, name: string, updatedAt: string, clientId?: string, seq?: number) {
  const doc: Doc = {
    id,
    schemaVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    createdBy: 'us/1',
    updatedBy: 'us/1',
    deletedAt: null,
    deletedBy: null,
    name,
  };
  return { doc, clientId, seq } satisfies PulledDocument<Doc>;
}

describe('foldSiblings', () => {
  it('keeps the later updatedAt among siblings of one document', () => {
    const out = foldSiblings([
      row('a', 'old', '2026-01-01T00:00:00.000Z', 'cl-1', 1),
      row('a', 'new', '2026-02-01T00:00:00.000Z', 'cl-2', 2),
      row('a', 'mid', '2026-01-15T00:00:00.000Z', 'cl-3', 3),
    ]);
    expect(out.map((r) => r.doc.name)).toEqual(['new']);
  });

  it('breaks an exact timestamp tie on clientId, regardless of arrival order', () => {
    const t = '2026-05-05T00:00:00.000Z';
    const forward = foldSiblings([row('a', 'from-1', t, 'cl-1'), row('a', 'from-2', t, 'cl-2')]);
    const reverse = foldSiblings([row('a', 'from-2', t, 'cl-2'), row('a', 'from-1', t, 'cl-1')]);
    expect(forward[0].doc.name).toBe('from-2');
    expect(reverse[0].doc.name).toBe('from-2');
  });

  it('preserves first-seen order of distinct ids', () => {
    const out = foldSiblings([
      row('b', 'b', '2026-01-01T00:00:00.000Z', 'cl-1', 1),
      row('a', 'a1', '2026-01-01T00:00:00.000Z', 'cl-1', 2),
      row('a', 'a2', '2026-01-02T00:00:00.000Z', 'cl-2', 3),
    ]);
    expect(out.map((r) => `${r.doc.id}:${r.doc.name}`)).toEqual(['b:b', 'a:a2']);
  });

  it('treats a row without clientId (pre-sibling server) as the lowest tiebreak', () => {
    const t = '2026-05-05T00:00:00.000Z';
    expect(compareSiblings(row('a', 'x', t), row('a', 'y', t, 'cl-1'))).toBeLessThan(0);
  });
});
