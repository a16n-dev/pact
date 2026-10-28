import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCollection } from '../src/collection';
import { yText } from '../src/yjs';

describe('defineCollection', () => {
  it('defaults key and synced', () => {
    const def = defineCollection({
      name: 'notes',
      idPrefix: 'n',
      merge: 'field',
      schema: (base) => base,
    });
    expect(def).toMatchObject({ key: 'notes', merge: 'field', synced: true, textFields: [] });
    expect(def.textEngine).toBeNull();
    expect(def.generateId()).toMatch(/^n-[A-Za-z0-9]{10}$/);
  });

  it('finds text fields declared with yText()', () => {
    const def = defineCollection({
      name: 'notes',
      idPrefix: 'n',
      merge: 'field',
      schema: (base) => base.extend({ title: z.string(), body: yText() }),
    });
    expect(def.textFields).toEqual(['body']);
    expect(def.textEngine).not.toBeNull();
  });

  it('rejects text fields in document-level collections', () => {
    expect(() =>
      defineCollection({
        name: 'notes',
        idPrefix: 'n',
        merge: 'document',
        schema: (base) => base.extend({ body: yText() }),
      })
    ).toThrow(/cannot declare text fields/);
  });

  it('rejects reserved and oversized keys and dashed prefixes', () => {
    expect(() =>
      defineCollection({ name: 'x', key: '_x', idPrefix: 'x', merge: 'field', schema: (b) => b })
    ).toThrow(/reserved/);
    expect(() =>
      defineCollection({
        name: 'x',
        key: 'k'.repeat(257),
        idPrefix: 'x',
        merge: 'field',
        schema: (b) => b,
      })
    ).toThrow(/1–256/);
    expect(() =>
      defineCollection({ name: 'x', idPrefix: 'a-b', merge: 'field', schema: (b) => b })
    ).toThrow(/must not contain/);
  });

  it('attaches indexes as a second step', () => {
    const def = defineCollection({
      name: 'notes',
      idPrefix: 'n',
      merge: 'field',
      schema: (base) => base.extend({ tag: z.string() }),
    }).withIndexes({ tag: (doc) => doc.tag });
    expect(Object.keys(def.indexes)).toEqual(['tag']);
  });
});
