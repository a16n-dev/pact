import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store } from '../src/store';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { date, defineCollection } from '../src/collection';
import { decodeHlc } from '../src/clock';
import { isSealedRecord, type StoredRecord } from '../src/record';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import { yText } from '../src/yjs';

const widgets = defineCollection({
  name: 'widgets',
  idPrefix: 'w',
  merge: 'field',
  schema: (base) =>
    base.extend({
      name: z.string(),
      count: z.number().default(0),
      note: z.string().nullable().optional(),
      due: date().optional(),
    }),
});

const notes = defineCollection({
  name: 'notes',
  key: 'n',
  idPrefix: 'nt',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), body: yText() }),
});

const settings = defineCollection({
  name: 'settings',
  idPrefix: 'st',
  merge: 'document',
  schema: (base) => base.extend({ theme: z.string(), size: z.number() }),
});

const tags = defineCollection({
  name: 'tags',
  idPrefix: 'tg',
  ids: 'slug',
  merge: 'field',
  schema: (base) => base.extend({ label: z.string(), uses: z.number().default(0) }),
});

async function setup() {
  const adapter = new InMemoryAdapter();
  const store = await Store.create({ adapter, collections: [widgets, notes, settings, tags] });
  return { adapter, store };
}

function stored(adapter: InMemoryAdapter, collection: string, id: string): Promise<StoredRecord> {
  return adapter.get(collection, id).then((r) => {
    if (!r || isSealedRecord(r)) throw new Error('expected a plain record');
    return r;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Store CRUD', () => {
  it('creates, reads, updates and soft-deletes with derived updatedAt', async () => {
    const { adapter, store } = await setup();
    const col = store.collection('widgets');
    const created = await col.create({ name: 'a' });
    expect(created.id).toMatch(/^w-/);
    expect(created.count).toBe(0);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.deletedAt).toBeNull();

    const record = await stored(adapter, 'widgets', created.id);
    expect(record.schemaVersion).toBe(1);
    expect(Object.keys(record.clocks!).sort()).toEqual(['count', 'deletedAt', 'name']);
    expect('updatedAt' in record.fields).toBe(false);

    const updated = await col.update(created.id, { name: 'b' });
    expect(updated.name).toBe('b');
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    const after = await stored(adapter, 'widgets', created.id);
    expect(after.clocks!.name! > record.clocks!.name!).toBe(true);
    expect(after.clocks!.count).toBe(record.clocks!.count);

    await col.delete(created.id);
    expect(await col.get(created.id)).toBeNull();
    expect((await col.get(created.id, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    expect(await col.list()).toEqual([]);
    expect(await col.list({ includeDeleted: true })).toHaveLength(1);
  });

  it('validates writes against the schema and rejects unknown collections', async () => {
    const { store } = await setup();
    await expect(
      store.collection('widgets').create({ name: 5 as unknown as string })
    ).rejects.toThrow();
    expect(() => store.collection('nope' as 'widgets')).toThrow(/Unknown collection/);
    await expect(store.collection('widgets').update('w-missing', { name: 'x' })).rejects.toThrow(
      /not found/
    );
    await expect(
      store.collection('widgets').create({ id: 'w-1', name: 'x' })
    ).resolves.toBeTruthy();
    await expect(store.collection('widgets').create({ id: 'w-1', name: 'y' })).rejects.toThrow(
      /already exists/
    );
  });

  it('stores dates as ISO strings and reads them back as Date', async () => {
    const { adapter, store } = await setup();
    const due = new Date('2026-03-01T00:00:00.000Z');
    const doc = await store.collection('widgets').create({ id: 'w-1', name: 'x', due });
    expect(doc.due).toBeInstanceOf(Date);
    expect((await stored(adapter, 'widgets', 'w-1')).fields.due).toBe(due.toISOString());
    expect((await store.collection('widgets').get('w-1'))?.due).toEqual(due);
  });

  it('getMany keeps input order and drops tombstones', async () => {
    const { store } = await setup();
    const col = store.collection('widgets');
    await col.createMany([
      { id: 'w-1', name: 'a' },
      { id: 'w-2', name: 'b' },
      { id: 'w-3', name: 'c' },
    ]);
    await col.delete('w-2');
    const docs = await col.getMany(['w-3', 'w-2', 'w-1', 'w-9']);
    expect(docs.map((d) => d.id)).toEqual(['w-3', 'w-1']);
  });

  it('upsert updates a live doc and revives a tombstone as a fresh doc', async () => {
    const { adapter, store } = await setup();
    const col = store.collection('widgets');
    await col.upsert({ id: 'w-1', name: 'a', note: 'keep' });
    await col.upsert({ id: 'w-1', name: 'b' });
    expect(await col.get('w-1')).toMatchObject({ name: 'b', note: 'keep' });
    await col.delete('w-1');
    await col.upsert({ id: 'w-1', name: 'c' });
    const revived = await col.get('w-1');
    expect(revived).toMatchObject({ name: 'c', deletedAt: null });
    expect(revived?.note).toBeUndefined();
    const record = await stored(adapter, 'widgets', 'w-1');
    // The dropped field keeps a clock so the drop wins against older values elsewhere.
    expect(record.clocks!.note).toBeDefined();
    expect('note' in record.fields).toBe(false);
  });

  it('slug-id collections require an id on create', async () => {
    const { adapter, store } = await setup();
    const col = store.collection('tags');
    // @ts-expect-error id is required for slug ids
    await expect(col.create({ label: 'Urgent' })).rejects.toThrow(/uses slug ids/);
    await expect(
      // @ts-expect-error id is required for slug ids
      col.createMany([{ id: 'tg-a', label: 'a' }, { label: 'b' }])
    ).rejects.toThrow(/uses slug ids/);
    expect(await adapter.getAll('tags')).toHaveLength(1);
    const created = await col.create({ id: 'tg-urgent', label: 'Urgent' });
    expect(created.id).toBe('tg-urgent');
  });

  it('getOrCreate returns a live doc untouched, creates when absent and revives a tombstone', async () => {
    const { adapter, store } = await setup();
    const col = store.collection('tags');
    const seen: string[] = [];
    store.on('change', (c) => c === 'tags' && seen.push(c));
    const first = await col.getOrCreate({ id: 'tg-urgent', label: 'Urgent' });
    await col.update('tg-urgent', { uses: 3 });
    const before = await stored(adapter, 'tags', 'tg-urgent');
    const again = await col.getOrCreate({ id: 'tg-urgent', label: 'Changed' });
    expect(again).toMatchObject({ id: first.id, label: 'Urgent', uses: 3 });
    expect(await stored(adapter, 'tags', 'tg-urgent')).toEqual(before);
    expect(seen).toEqual(['tags', 'tags']);
    await col.delete('tg-urgent');
    const revived = await col.getOrCreate({ id: 'tg-urgent', label: 'Back' });
    expect(revived).toMatchObject({
      label: 'Back',
      uses: 0,
      deletedAt: null,
      createdAt: first.createdAt,
    });
  });

  it('emits change per collection and once per batch', async () => {
    const { store } = await setup();
    const seen: string[] = [];
    store.on('change', (c) => seen.push(c));
    await store.collection('widgets').createMany([{ name: 'a' }, { name: 'b' }]);
    await store.collection('settings').create({ theme: 'dark', size: 1 });
    expect(seen.filter((c) => c === 'widgets')).toHaveLength(1);
    expect(seen.filter((c) => c === 'settings')).toHaveLength(1);
    expect(seen).toContain('_outbox');
  });

  it('queues an outbox entry per write, keyed by collection key and id', async () => {
    const { adapter, store } = await setup();
    await store.collection('notes').create({ id: 'nt-1', title: 't', body: 'hi' });
    await store.collection('notes').update('nt-1', { title: 'u' });
    const entries = await adapter.getAll('_outbox');
    expect(entries.map((e) => e.id)).toEqual(['n/nt-1']);
    expect(await adapter.get('n', 'nt-1')).not.toBeNull();
  });

  it('refuses a document over 1 MB without storing it', async () => {
    const { store } = await setup();
    await expect(
      store.collection('widgets').create({ id: 'w-big', name: 'x'.repeat(1_000_001) })
    ).rejects.toThrow(/widgets\/w-big.*1 MB/);
    expect(await store.collection('widgets').get('w-big')).toBeNull();
  });

  it('uses one record clock in document-level collections', async () => {
    const { adapter, store } = await setup();
    const doc = await store.collection('settings').create({ id: 'st-1', theme: 'dark', size: 2 });
    const record = await stored(adapter, 'settings', 'st-1');
    expect(record.clock).toBeDefined();
    expect(record.clocks).toBeUndefined();
    await store.collection('settings').update('st-1', { size: 3 });
    const after = await stored(adapter, 'settings', 'st-1');
    expect(after.clock! > record.clock!).toBe(true);
    expect(decodeHlc(after.clock!).node).toBe(decodeHlc(record.clock!).node);
    expect(doc.updatedAt).toBe(new Date(decodeHlc(record.clock!).wallMs).toISOString());
  });

  it('persists the HLC node across restarts', async () => {
    const adapter = new InMemoryAdapter();
    const a = await Store.create({ adapter, collections: [widgets] });
    await a.collection('widgets').create({ id: 'w-1', name: 'x' });
    const first = (await stored(adapter, 'widgets', 'w-1')).clocks!.name;
    const b = await Store.create({ adapter, collections: [widgets] });
    await b.collection('widgets').update('w-1', { name: 'y' });
    const second = (await stored(adapter, 'widgets', 'w-1')).clocks!.name;
    expect(decodeHlc(second!).node).toBe(decodeHlc(first!).node);
  });
});

describe('text fields', () => {
  it('projects text to a string and applies string writes as replace-all', async () => {
    const { adapter, store } = await setup();
    const col = store.collection('notes');
    const created = await col.create({ id: 'nt-1', title: 't', body: 'hello' });
    expect(created.body).toBe('hello');
    expect((await stored(adapter, 'n', 'nt-1')).text).toBeDefined();
    await col.update('nt-1', { body: 'bye' });
    expect((await col.get('nt-1'))?.body).toBe('bye');
  });

  it('persists every transaction on the live text and stamps its clock', async () => {
    const { adapter, store } = await setup();
    const col = store.collection('notes');
    await col.create({ id: 'nt-1', title: 't', body: 'hello' });
    const before = await stored(adapter, 'n', 'nt-1');
    const text = await col.text('nt-1', 'body');
    const seen: string[] = [];
    store.on('change', (c) => seen.push(c));
    text.insert(5, ' world');
    await vi.waitFor(async () => {
      expect((await stored(adapter, 'n', 'nt-1')).text).not.toBe(before.text);
    });
    const after = await stored(adapter, 'n', 'nt-1');
    expect(after.clocks!.body! > before.clocks!.body!).toBe(true);
    expect(after.clocks!.title).toBe(before.clocks!.title);
    expect(seen).toContain('notes');
    expect((await col.get('nt-1'))?.body).toBe('hello world');
    expect(await col.text('nt-1', 'body')).toBe(text);
    await expect(col.text('nt-9', 'body')).rejects.toThrow(/not found/);
  });

  it('reopens text state from storage on a new store', async () => {
    const adapter = new InMemoryAdapter();
    const a = await Store.create({ adapter, collections: [notes] });
    await a.collection('notes').create({ id: 'nt-1', title: 't', body: 'abc' });
    (await a.collection('notes').text('nt-1', 'body')).insert(3, 'd');
    await vi.waitFor(async () => {
      expect((await a.collection('notes').get('nt-1'))?.body).toBe('abcd');
    });
    const b = await Store.create({ adapter, collections: [notes] });
    expect((await b.collection('notes').get('nt-1'))?.body).toBe('abcd');
  });
});

describe('migrations', () => {
  const v2 = defineCollection({
    name: 'widgets',
    idPrefix: 'w',
    merge: 'field',
    schema: (base) => base.extend({ title: z.string(), count: z.number() }),
    migrations: {
      current: 2,
      migrations: [{ from: 1, to: 2, up: (f) => ({ ...f, title: f.name, name: undefined }) }],
    },
  });

  it('migrates lazily on read, keeping clocks for surviving fields', async () => {
    const adapter = new InMemoryAdapter();
    const old = await Store.create({ adapter, collections: [widgets] });
    await old.collection('widgets').create({ id: 'w-1', name: 'x', count: 3 });
    const before = await stored(adapter, 'widgets', 'w-1');

    const store = await Store.create({ adapter, collections: [v2] });
    const doc = await store.collection('widgets').get('w-1');
    expect(doc).toMatchObject({ title: 'x', count: 3 });
    await vi.waitFor(async () => {
      expect((await stored(adapter, 'widgets', 'w-1')).schemaVersion).toBe(2);
    });
    const after = await stored(adapter, 'widgets', 'w-1');
    expect(after.clocks!.count).toBe(before.clocks!.count);
    expect(after.clocks!.title).toBe(before.clocks!.name);
    expect(after.clocks!.name).toBeUndefined();
    expect('name' in after.fields).toBe(false);
  });

  it('hides records newer than the build instead of crashing', async () => {
    const adapter = new InMemoryAdapter();
    const store = await Store.create({ adapter, collections: [v2] });
    await store.collection('widgets').create({ id: 'w-1', title: 'x', count: 1 });
    const downgraded = await Store.create({ adapter, collections: [widgets] });
    expect(await downgraded.collection('widgets').get('w-1')).toBeNull();
    expect(await downgraded.collection('widgets').list()).toEqual([]);
  });
});

describe('indexes', () => {
  const indexed = defineCollection({
    name: 'widgets',
    idPrefix: 'w',
    merge: 'field',
    schema: (base) => base.extend({ name: z.string(), tags: z.array(z.string()).default([]) }),
  }).withIndexes({ tag: (doc) => doc.tags, name: (doc) => doc.name });

  it('answers equality lookups and follows writes, deletes and restarts', async () => {
    const adapter = new InMemoryAdapter();
    const store = await Store.create({ adapter, collections: [indexed] });
    const col = store.collection('widgets');
    await col.create({ id: 'w-1', name: 'a', tags: ['x', 'y'] });
    await col.create({ id: 'w-2', name: 'b', tags: ['y'] });
    expect((await col.listByIndex('tag', 'y')).map((d) => d.id).sort()).toEqual(['w-1', 'w-2']);
    await col.update('w-1', { tags: [] });
    expect((await col.listByIndex('tag', 'y')).map((d) => d.id)).toEqual(['w-2']);
    await col.delete('w-2');
    expect(await col.listByIndex('tag', 'y')).toEqual([]);
    await expect(col.listByIndex('nope' as 'tag', 'y')).rejects.toThrow(/Unknown index/);

    const again = await Store.create({ adapter, collections: [indexed] });
    expect((await again.collection('widgets').listByIndex('name', 'a')).map((d) => d.id)).toEqual([
      'w-1',
    ]);
  });
});

describe('encryption', () => {
  const key = () => deriveEncryptionKey('pw', 'salt', 1_000);

  it('seals records at rest and refuses a wrong key on an install with data', async () => {
    const adapter = new InMemoryAdapter();
    const cipher = createWebCryptoCipher(await key());
    const store = await Store.create({ adapter, collections: [widgets], encryption: { cipher } });
    await store.collection('widgets').create({ id: 'w-1', name: 'secret' });
    const raw = await adapter.get('widgets', 'w-1');
    expect(raw && isSealedRecord(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('secret');

    const reopened = await Store.create({
      adapter,
      collections: [widgets],
      encryption: { cipher },
    });
    expect((await reopened.collection('widgets').get('w-1'))?.name).toBe('secret');

    const wrong = createWebCryptoCipher(await deriveEncryptionKey('other', 'salt', 1_000));
    await expect(
      Store.create({ adapter, collections: [widgets], encryption: { cipher: wrong } })
    ).rejects.toThrow(/does not match/);
  });

  it('encryptLocal seals existing plaintext rows once', async () => {
    const adapter = new InMemoryAdapter();
    const plain = await Store.create({ adapter, collections: [widgets] });
    await plain.collection('widgets').create({ id: 'w-1', name: 'a' });
    const cipher = createWebCryptoCipher(await key());
    const store = await Store.create({ adapter, collections: [widgets], encryption: { cipher } });
    expect((await store.collection('widgets').get('w-1'))?.name).toBe('a');
    expect(await store.encryption.encryptLocal()).toEqual({ rewritten: 1 });
    expect(await store.encryption.encryptLocal()).toEqual({ rewritten: 0 });
    const raw = await adapter.get('widgets', 'w-1');
    expect(raw && isSealedRecord(raw)).toBe(true);
    expect((await store.collection('widgets').get('w-1'))?.name).toBe('a');
  });
});

describe('backups', () => {
  it('round-trips records through merge and replace restores', async () => {
    const { store } = await setup();
    await store.collection('widgets').create({ id: 'w-1', name: 'a' });
    await store.collection('notes').create({ id: 'nt-1', title: 't', body: 'text' });
    const archive = await store.backup.create();

    const { store: target } = await setup();
    await target.collection('widgets').create({ id: 'w-2', name: 'local' });
    const merged = await target.backup.restore(archive);
    expect(merged).toMatchObject({ mode: 'merge', docsWritten: 2, docsSkipped: 0 });
    expect(merged.collections.sort()).toEqual(['notes', 'widgets']);
    expect((await target.collection('notes').get('nt-1'))?.body).toBe('text');
    expect((await target.collection('widgets').list()).map((d) => d.id).sort()).toEqual([
      'w-1',
      'w-2',
    ]);

    const again = await target.backup.restore(archive);
    expect(again.docsSkipped).toBe(2);

    const replaced = await target.backup.restore(archive, { mode: 'replace' });
    expect(replaced.docsWritten).toBe(2);
    expect((await target.collection('widgets').list()).map((d) => d.id)).toEqual(['w-1']);
  });

  it('merges by clock so a newer local edit survives an older archive', async () => {
    const { store } = await setup();
    await store.collection('widgets').create({ id: 'w-1', name: 'old' });
    const archive = await store.backup.create();
    await store.collection('widgets').update('w-1', { name: 'new' });
    await store.backup.restore(archive);
    expect((await store.collection('widgets').get('w-1'))?.name).toBe('new');
  });
});
