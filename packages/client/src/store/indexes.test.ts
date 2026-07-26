import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Store } from './store';
import { InMemoryAdapter } from '../adapters/memoryAdapter';
import { defineCollection, date } from '../collection';
import { createWebCryptoCipher } from '../crypto/webCrypto';
import { isEncryptedDoc } from '../crypto/docCrypto';
import type { DatabaseAdapter } from '../adapters/adapter';
import type { BaseDocument } from '../types';

// A collection that declares three indexes: a single-valued string field, a
// multi-valued array field, and a numeric field (exercising key coercion).
const tasksDef = defineCollection({
  name: 'tasks',
  idPrefix: 't',
  schema: (base) =>
    base.extend({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      tags: z.array(z.string()).default([]),
      priority: z.number().optional(),
      due: date().optional(),
    }),
}).withIndexes({
  status: (t) => t.status,
  tag: (t) => t.tags,
  priority: (t) => (t.priority === undefined ? [] : t.priority),
  due: (t) => (t.due ? [t.due] : []),
});

type Task = z.output<typeof tasksDef.schema> & BaseDocument;

async function makeStore(adapter: DatabaseAdapter = new InMemoryAdapter()) {
  const store = await Store.create({ adapter, collections: [tasksDef] });
  await store.author.set('us/1');
  return { store, adapter, tasks: () => store.collection('tasks') };
}

function rawTask(id: string, fields: Partial<Task> & { title: string; status: string }): Task {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'us/1',
    updatedBy: 'us/1',
    deletedAt: null,
    deletedBy: null,
    tags: [],
    ...fields,
  } as Task;
}

const ids = (docs: Task[]) => docs.map((d) => d.id).sort();

describe('secondary indexes — queries', () => {
  it('finds docs by a single-valued index', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [] });
    await tasks().create({ id: 't2', title: 'B', status: 'done', tags: [] });
    await tasks().create({ id: 't3', title: 'C', status: 'open', tags: [] });

    expect(ids(await store.collection('tasks').listByIndex('status', 'open'))).toEqual([
      't1',
      't3',
    ]);
    expect(ids(await store.collection('tasks').listByIndex('status', 'done'))).toEqual(['t2']);
  });

  it('returns an empty array for an unmatched key', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [] });
    expect(await store.collection('tasks').listByIndex('status', 'archived')).toEqual([]);
  });

  it('indexes every value of a multi-valued extractor', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: ['home', 'urgent'] });
    await tasks().create({ id: 't2', title: 'B', status: 'open', tags: ['work'] });
    await tasks().create({ id: 't3', title: 'C', status: 'open', tags: ['home'] });

    expect(ids(await store.collection('tasks').listByIndex('tag', 'home'))).toEqual(['t1', 't3']);
    expect(ids(await store.collection('tasks').listByIndex('tag', 'urgent'))).toEqual(['t1']);
    expect(ids(await store.collection('tasks').listByIndex('tag', 'work'))).toEqual(['t2']);
  });

  it('coerces non-string keys (number, Date) for both extract and query', async () => {
    const { store, tasks } = await makeStore();
    const due = new Date('2026-03-01T00:00:00.000Z');
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [], priority: 2, due });
    await tasks().create({ id: 't2', title: 'B', status: 'open', tags: [], priority: 2 });
    await tasks().create({ id: 't3', title: 'C', status: 'open', tags: [], priority: 5 });

    // number query and string query both resolve to the same bucket
    expect(ids(await store.collection('tasks').listByIndex('priority', 2))).toEqual(['t1', 't2']);
    expect(ids(await store.collection('tasks').listByIndex('priority', '2'))).toEqual(['t1', 't2']);
    expect(ids(await store.collection('tasks').listByIndex('priority', 5))).toEqual(['t3']);
    // Date key matches regardless of how it's reconstructed
    expect(ids(await store.collection('tasks').listByIndex('due', new Date(due)))).toEqual(['t1']);
  });

  it('throws on an unknown index name', async () => {
    const { store } = await makeStore();
    await expect(store.collection('tasks').listByIndex('nope' as never, 'x')).rejects.toThrow(
      /Unknown index "nope"/
    );
  });
});

describe('secondary indexes — maintenance', () => {
  it('moves a doc between buckets when the indexed field changes', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [] });
    expect(ids(await store.collection('tasks').listByIndex('status', 'open'))).toEqual(['t1']);

    await tasks().update('t1', { status: 'done' });
    expect(await store.collection('tasks').listByIndex('status', 'open')).toEqual([]);
    expect(ids(await store.collection('tasks').listByIndex('status', 'done'))).toEqual(['t1']);
  });

  it('drops removed values from a multi-valued index on update', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: ['home', 'urgent'] });
    await tasks().update('t1', { tags: ['home'] });

    expect(ids(await store.collection('tasks').listByIndex('tag', 'home'))).toEqual(['t1']);
    expect(await store.collection('tasks').listByIndex('tag', 'urgent')).toEqual([]);
  });

  it('removes a soft-deleted doc from its indexes', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: ['home'] });
    await tasks().delete('t1');

    expect(await store.collection('tasks').listByIndex('status', 'open')).toEqual([]);
    expect(await store.collection('tasks').listByIndex('tag', 'home')).toEqual([]);
  });

  it('removes a hard-deleted doc from its indexes', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: ['home'] });
    await store.collection('tasks').hardDelete('t1');

    expect(await store.collection('tasks').listByIndex('status', 'open')).toEqual([]);
    expect(await store.collection('tasks').listByIndex('tag', 'home')).toEqual([]);
  });

  it('reflects batch writes (createMany / updateMany)', async () => {
    const { store, tasks } = await makeStore();
    await tasks().createMany([
      { id: 't1', title: 'A', status: 'open', tags: [] },
      { id: 't2', title: 'B', status: 'open', tags: [] },
    ]);
    expect(ids(await store.collection('tasks').listByIndex('status', 'open'))).toEqual([
      't1',
      't2',
    ]);

    await tasks().updateMany([{ id: 't1', status: 'done' }]);
    expect(ids(await store.collection('tasks').listByIndex('status', 'open'))).toEqual(['t2']);
    expect(ids(await store.collection('tasks').listByIndex('status', 'done'))).toEqual(['t1']);
  });

  it('revives an upserted-back tombstone into the index', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [] });
    await tasks().delete('t1');
    expect(await store.collection('tasks').listByIndex('status', 'open')).toEqual([]);

    await tasks().upsert({ id: 't1', title: 'A', status: 'reopened', tags: [] });
    expect(ids(await store.collection('tasks').listByIndex('status', 'reopened'))).toEqual(['t1']);
  });

  it('clears indexes on wipe', async () => {
    const { store, tasks } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [] });
    await store.wipe();
    expect(await store.collection('tasks').listByIndex('status', 'open')).toEqual([]);
  });
});

describe('secondary indexes — rebuild on load', () => {
  it('rebuilds from persisted docs in a fresh Store.create', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.put('tasks', rawTask('t1', { title: 'A', status: 'open', tags: ['home'] }));
    await adapter.put('tasks', rawTask('t2', { title: 'B', status: 'done', tags: ['home'] }));

    const store = await Store.create({ adapter, collections: [tasksDef] });
    expect(ids(await store.collection('tasks').listByIndex('status', 'open'))).toEqual(['t1']);
    expect(ids(await store.collection('tasks').listByIndex('tag', 'home'))).toEqual(['t1', 't2']);
  });

  it('excludes tombstones when rebuilding', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.put(
      'tasks',
      rawTask('t1', {
        title: 'A',
        status: 'open',
        tags: [],
        deletedAt: '2026-01-02T00:00:00.000Z',
        deletedBy: 'us/1',
      })
    );
    const store = await Store.create({ adapter, collections: [tasksDef] });
    expect(await store.collection('tasks').listByIndex('status', 'open')).toEqual([]);
  });
});

describe('secondary indexes — isolation', () => {
  it('does not touch stores whose collections declare no index', async () => {
    const plainDef = defineCollection({
      name: 'notes',
      idPrefix: 'n',
      schema: (base) => base.extend({ id: z.string(), body: z.string() }),
    });
    const store = await Store.create({ adapter: new InMemoryAdapter(), collections: [plainDef] });
    await store.author.set('us/1');
    await store.collection('notes').create({ id: 'n1', body: 'hi' });
    // No index API is available and nothing throws on the normal write path.
    expect(await store.collection('notes').get('n1')).toMatchObject({ id: 'n1', body: 'hi' });
  });
});

describe('secondary indexes — under encryption', () => {
  it('indexes decrypted docs in memory while storage holds only ciphertext', async () => {
    const cipher = createWebCryptoCipher(new Uint8Array(32).fill(7));
    const inner = new InMemoryAdapter();
    const store = await Store.create({
      adapter: inner,
      collections: [tasksDef],
      encryption: { cipher },
    });
    await store.author.set('us/1');
    await store
      .collection('tasks')
      .create({ id: 't1', title: 'A', status: 'open', tags: ['home'] });

    // Query works — the index saw the plaintext doc as it was written.
    expect(ids(await store.collection('tasks').listByIndex('tag', 'home'))).toEqual(['t1']);

    // ...but nothing readable reached storage: the row is an envelope and the
    // indexed value never appears in the persisted bytes.
    const stored = await inner.get<BaseDocument>('tasks', 't1');
    expect(isEncryptedDoc(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('home');
  });

  it('rebuilds the index by decrypting on load', async () => {
    const cipher = createWebCryptoCipher(new Uint8Array(32).fill(7));
    const inner = new InMemoryAdapter();
    // First store writes an encrypted doc.
    const first = await Store.create({
      adapter: inner,
      collections: [tasksDef],
      encryption: { cipher },
    });
    await first.author.set('us/1');
    await first
      .collection('tasks')
      .create({ id: 't1', title: 'A', status: 'open', tags: ['home'] });

    // A fresh store over the same ciphertext rebuilds the index on create.
    const second = await Store.create({
      adapter: inner,
      collections: [tasksDef],
      encryption: { cipher },
    });
    expect(ids(await second.collection('tasks').listByIndex('tag', 'home'))).toEqual(['t1']);
  });
});

describe('secondary indexes — self-healing via getMany', () => {
  it('never returns a doc the index over-reports (deleted underneath)', async () => {
    // Hard-delete straight through the adapter so the index is intentionally
    // left stale; listByIndex must still not surface the vanished doc because
    // it re-reads through getMany.
    const { store, tasks, adapter } = await makeStore();
    await tasks().create({ id: 't1', title: 'A', status: 'open', tags: [] });
    await tasks().create({ id: 't2', title: 'B', status: 'open', tags: [] });
    await adapter.delete('tasks', 't1'); // bypasses the store's remove()

    expect(ids(await store.collection('tasks').listByIndex('status', 'open'))).toEqual(['t2']);
  });
});
