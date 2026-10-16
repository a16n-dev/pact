import { describe, expect, it } from 'vitest';
import { yjsTextEngine } from '../src/yjs';

describe('yjsTextEngine', () => {
  it('round-trips state and merges concurrent edits from two documents', () => {
    const a = yjsTextEngine.open(['body']);
    a.handle('body').insert(0, 'hello');
    const b = yjsTextEngine.open(['body'], a.encode());
    expect(b.toString('body')).toBe('hello');

    a.handle('body').insert(5, ' world');
    b.handle('body').insert(0, 'oh ');
    expect(a.merge(b.encode())).toBe(true);
    expect(b.merge(a.encode())).toBe(true);
    expect(a.toString('body')).toBe('oh hello world');
    expect(b.toString('body')).toBe(a.toString('body'));
    expect(a.merge(b.encode())).toBe(false);
  });

  it('detects a delete-only update as a change', () => {
    const a = yjsTextEngine.open(['body']);
    a.handle('body').insert(0, 'hello');
    const b = yjsTextEngine.open(['body'], a.encode());
    b.handle('body').delete(0, 2);
    expect(a.merge(b.encode())).toBe(true);
    expect(a.toString('body')).toBe('llo');
  });

  it('reports local transactions with the fields touched, not store-applied ones', () => {
    const doc = yjsTextEngine.open(['title', 'body']);
    const seen: string[][] = [];
    const off = doc.onLocalChange((fields) => seen.push([...fields]));
    doc.handle('body').insert(0, 'x');
    doc.replace('title', 'set by store');
    const other = yjsTextEngine.open(['title', 'body']);
    other.handle('title').insert(0, 'remote');
    doc.merge(other.encode());
    expect(seen).toEqual([['body']]);
    off();
    doc.handle('body').insert(0, 'y');
    expect(seen).toHaveLength(1);
  });

  it('rejects unknown fields', () => {
    expect(() => yjsTextEngine.open(['body']).handle('nope')).toThrow(/not a text field/);
  });
});
