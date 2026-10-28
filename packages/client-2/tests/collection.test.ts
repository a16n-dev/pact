import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCollection, slugId, slugify } from '../src/collection';
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

  it('defaults to random ids and rejects idLength on slug ids', () => {
    const def = defineCollection({ name: 'n', idPrefix: 'n', merge: 'field', schema: (b) => b });
    expect(def.ids).toBe('random');
    expect(() =>
      defineCollection({
        name: 'n',
        idPrefix: 'n',
        ids: 'slug',
        idLength: 4,
        merge: 'field',
        schema: (b) => b,
      })
    ).toThrow(/cannot set idLength/);
  });

  it('slug ids must be lowercase words joined by single hyphens', () => {
    const def = defineCollection({
      name: 'n',
      idPrefix: 'in',
      ids: 'slug',
      merge: 'field',
      schema: (b) => b,
    });
    const id = def.schema.shape.id;
    expect(id.safeParse('in-brown-onion').success).toBe(true);
    expect(id.safeParse('in-Brown Onion').success).toBe(false);
    expect(id.safeParse('in-brown--onion').success).toBe(false);
    expect(id.safeParse('in-').success).toBe(false);
  });

  it('slugify drops accents and punctuation, and slugId is null when nothing is left', () => {
    expect(slugify(' Onion or  Shallot ')).toBe('onion-or-shallot');
    expect(slugify('Crème fraîche!')).toBe('creme-fraiche');
    expect(slugify('salt & pepper')).toBe('salt-pepper');
    expect(slugId('in', 'Brown Onion')).toBe('in-brown-onion');
    expect(slugId('in', ' - ')).toBeNull();
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
