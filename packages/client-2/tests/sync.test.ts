import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store } from '../src/store';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { defineCollection } from '../src/collection';
import { encodeHlc } from '../src/clock';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import type { DocCipher } from '../src/crypto/types';
import { yText } from '../src/yjs';
import { FakeServer } from './fakeServer';
import type { StoredRecord } from '../src/record';

const notes = defineCollection({
  name: 'notes',
  key: 'n',
  idPrefix: 'nt',
  schema: (base) => base.extend({ title: z.string(), tags: z.array(z.string()).default([]) }),
});

const docs = defineCollection({
  name: 'docs',
  idPrefix: 'd',
  schema: (base) => base.extend({ body: yText() }),
});

const local = defineCollection({
  name: 'prefs',
  idPrefix: 'p',
  synced: false,
  schema: (base) => base.extend({ theme: z.string() }),
});

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  server.createApp('app');
  server.createUser('alice', 'pw');
  vi.stubGlobal('fetch', server.fetch);
  vi.stubGlobal('WebSocket', server.WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Options = { adapter?: InMemoryAdapter; cipher?: DocCipher; collections?: any[] };

async function signedInStore(deviceName: string, opts: Options = {}) {
  const adapter = opts.adapter ?? new InMemoryAdapter();
  const store = await Store.create({
    adapter,
    collections: opts.collections ?? [notes, docs, local],
    encryption: opts.cipher ? { cipher: opts.cipher } : undefined,
  });
  const begun = await store.sync.beginSignIn({
    url: server.origin,
    appId: 'app',
    deviceName,
    redirectUri: 'https://app.test/callback',
  });
  const redirect = server.authorize(begun.authorizeUrl, { username: 'alice', password: 'pw' });
  if ('error' in redirect) throw new Error(redirect.error);
  const result = await store.sync.completeSignIn(redirect);
  expect(result).toEqual({ ok: true });
  await vi.waitFor(() => expect(server.openSockets('app')).toBeGreaterThan(0));
  return { store, adapter };
}

async function settled(store: Store<any>) {
  await store.sync.drain();
  await store.sync.pull();
}

function record(fields: Record<string, unknown>, clocks: Record<string, string>): StoredRecord {
  return {
    schemaVersion: 1,
    fields: { createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...fields },
    clocks,
  };
}

describe('sign-in', () => {
  it('runs the PKCE flow and persists the session', async () => {
    const { store } = await signedInStore('Laptop');
    const registration = await store.sync.registration();
    expect(registration).toMatchObject({ url: server.origin, appId: 'app', deviceName: 'Laptop' });
    expect(registration?.deviceId).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(await store.sync.session()).toEqual({
      appId: 'app',
      user: 'alice',
      deviceName: 'Laptop',
    });
    const creds = await store.sync.credentials();
    expect(creds?.url).toBe(server.origin);
    expect(creds?.token).toMatch(/^pact_/);
  });

  it('rejects a mismatched state and a bad code', async () => {
    const store = await Store.create({ adapter: new InMemoryAdapter(), collections: [notes] });
    const begun = await store.sync.beginSignIn({
      url: `${server.origin}/`,
      appId: 'app',
      deviceName: 'Laptop',
      redirectUri: 'https://app.test/callback',
    });
    expect(await store.sync.completeSignIn({ code: 'x', state: 'wrong' })).toEqual({
      ok: false,
      reason: 'state',
    });
    expect(await store.sync.completeSignIn({ code: 'x', state: begun.state })).toEqual({
      ok: false,
      reason: 'code',
    });
    expect(await store.sync.session()).toBeNull();
    expect(await store.sync.credentials()).toBeNull();
  });

  it('survives a page reload between begin and complete', async () => {
    const adapter = new InMemoryAdapter();
    const first = await Store.create({ adapter, collections: [notes] });
    const begun = await first.sync.beginSignIn({
      url: server.origin,
      appId: 'app',
      deviceName: 'Web',
      redirectUri: 'https://app.test/callback',
    });
    const redirect = server.authorize(begun.authorizeUrl, { username: 'alice', password: 'pw' });
    if ('error' in redirect) throw new Error(redirect.error);
    const second = await Store.create({ adapter, collections: [notes] });
    expect(await second.sync.completeSignIn(redirect)).toEqual({ ok: true });
  });

  it('reconnects on startup with a stored token and signs out when it is revoked', async () => {
    const { store, adapter } = await signedInStore('Laptop');
    store.dispose();
    const again = await Store.create({ adapter, collections: [notes, docs, local] });
    await vi.waitFor(() => expect(server.openSockets('app')).toBe(1));
    const signedOut = vi.fn();
    again.on('signedOut', signedOut);
    server.revoke((await again.sync.credentials())!.token);
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1));
    expect(await again.sync.credentials()).toBeNull();
    expect(await again.sync.registration()).not.toBeNull();
    expect(server.openSockets('app')).toBe(0);
  });

  it('signs out when a stored token is rejected at startup', async () => {
    const { store, adapter } = await signedInStore('Laptop');
    const token = (await store.sync.credentials())!.token;
    store.dispose();
    server.revoke(token);
    const again = await Store.create({ adapter, collections: [notes, docs, local] });
    const signedOut = vi.fn();
    again.on('signedOut', signedOut);
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalled());
    expect(await again.sync.credentials()).toBeNull();
  });

  it('signOut tells the server and keeps local data', async () => {
    const { store } = await signedInStore('Laptop');
    await store.collection('notes').create({ id: 'nt-1', title: 'a' });
    await store.sync.signOut();
    expect(server.tokensFor('app')).toEqual([]);
    expect(await store.sync.credentials()).toBeNull();
    expect((await store.collection('notes').get('nt-1'))?.title).toBe('a');
    expect(server.openSockets('app')).toBe(0);
  });
});

describe('push and pull', () => {
  it('pushes writes as versions and syncs them to another device', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B');
    await a.store.collection('notes').create({ id: 'nt-1', title: 'hello' });
    await a.store.sync.drain();
    expect(await a.store.sync.pending()).toBe(0);
    const versions = server.versionsOf('app', 'n', 'nt-1');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.hlc).toMatch(/^\d{13}-[0-9a-f]{4}-/);

    const changed = vi.fn();
    b.store.on('change', changed);
    await vi.waitFor(async () => {
      expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('hello');
    });
    expect(changed).toHaveBeenCalledWith('notes');
    expect(await b.store.sync.lastSyncedAt()).toBeInstanceOf(Date);
  });

  it('merges concurrent field edits from two devices', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B');
    await a.store.collection('notes').create({ id: 'nt-1', title: 't', tags: ['x'] });
    await a.store.sync.drain();
    await vi.waitFor(async () =>
      expect(await b.store.collection('notes').get('nt-1')).not.toBeNull()
    );

    await a.store.collection('notes').update('nt-1', { title: 'from a' });
    await b.store.collection('notes').update('nt-1', { tags: ['from b'] });
    await settled(a.store);
    await settled(b.store);
    await settled(a.store);
    const expected = { title: 'from a', tags: ['from b'] };
    expect(await a.store.collection('notes').get('nt-1')).toMatchObject(expected);
    expect(await b.store.collection('notes').get('nt-1')).toMatchObject(expected);
  });

  it('merges concurrent text edits', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B');
    await a.store.collection('docs').create({ id: 'd-1', body: 'hello' });
    await a.store.sync.drain();
    await vi.waitFor(async () =>
      expect(await b.store.collection('docs').get('d-1')).not.toBeNull()
    );

    (await a.store.collection('docs').text('d-1', 'body')).insert(5, ' world');
    (await b.store.collection('docs').text('d-1', 'body')).insert(0, 'oh ');
    await vi.waitFor(async () => {
      expect(await a.store.sync.pending()).toBe(0);
      expect(await b.store.sync.pending()).toBe(0);
    });
    await settled(a.store);
    await settled(b.store);
    await settled(a.store);
    const textA = await a.store.collection('docs').text('d-1', 'body');
    expect(textA.toString()).toBe('oh hello world');
    expect((await b.store.collection('docs').get('d-1'))?.body).toBe('oh hello world');
  });

  it('debounces text pushes per document', async () => {
    const { store } = await signedInStore('A');
    // Realtime's open-time pull and drain would otherwise race the edits below.
    store.dispose();
    await store.collection('docs').create({ id: 'd-1', body: '' });
    await store.sync.drain();
    const before = server.requests.filter((r) => r.path === '/sync/push').length;
    const text = await store.collection('docs').text('d-1', 'body');
    for (const ch of 'abcdef') text.insert(text.length, ch);
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(1));
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0), { timeout: 3_000 });
    expect(server.versionsOf('app', 'docs', 'd-1')).toHaveLength(1);
    expect(server.requests.filter((r) => r.path === '/sync/push').length - before).toBe(1);
  });

  it('queues writes made before sign-in and pushes them after', async () => {
    const adapter = new InMemoryAdapter();
    const offline = await Store.create({ adapter, collections: [notes, docs, local] });
    await offline.collection('notes').create({ id: 'nt-1', title: 'queued' });
    await offline.collection('prefs').create({ id: 'p-1', theme: 'dark' });
    expect(await offline.sync.pending()).toBe(1);
    const { store } = await signedInStore('A', { adapter });
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0));
    expect(server.versionsOf('app', 'n', 'nt-1')).toHaveLength(1);
    expect(server.versionsOf('app', 'prefs', 'p-1')).toHaveLength(0);
  });

  it('chunks pushes by max_push_documents, mixing collections', async () => {
    server.maxPushDocuments = 3;
    const { store } = await signedInStore('A');
    server.offline = true;
    await store.collection('notes').createMany([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    await store.collection('docs').createMany([{ body: 'x' }, { body: 'y' }]);
    expect(await store.sync.pending()).toBe(5);
    server.offline = false;
    const before = server.requests.filter((r) => r.path === '/sync/push').length;
    await store.sync.drain();
    expect(server.requests.filter((r) => r.path === '/sync/push').length - before).toBe(2);
    expect(await store.sync.pending()).toBe(0);
  });

  it('leaves the outbox intact when a push fails', async () => {
    const { store } = await signedInStore('A');
    server.offline = true;
    await store.collection('notes').create({ id: 'nt-1', title: 'a' });
    await expect(store.sync.drain()).rejects.toThrow();
    expect(await store.sync.pending()).toBe(1);
    server.offline = false;
    await store.sync.drain();
    expect(await store.sync.pending()).toBe(0);
  });

  it('skips versions beyond the drift bound and sealed ones, holds newer schemas', async () => {
    const { store } = await signedInStore('A');
    const other = server.apiToken('app');
    const future = encodeHlc({ wallMs: Date.now() + 120_000, counter: 0, node: 'future' });
    const ok = encodeHlc({ wallMs: Date.now() - 1_000, counter: 0, node: 'other' });
    server.seed(other, [
      {
        collection: 'n',
        id: 'nt-drift',
        hlc: future,
        data: JSON.stringify(record({ id: 'nt-drift', title: 'x' }, { title: future })),
      },
      { collection: 'n', id: 'nt-sealed', hlc: ok, data: 'pactenc$1$abc$def' },
      {
        collection: 'n',
        id: 'nt-held',
        hlc: ok,
        data: JSON.stringify({
          ...record({ id: 'nt-held', title: 'x' }, { title: ok }),
          schemaVersion: 9,
        }),
      },
      {
        collection: 'n',
        id: 'nt-bad',
        hlc: ok,
        data: JSON.stringify(record({ id: 'nt-bad', title: 5 }, { title: ok })),
      },
      {
        collection: 'n',
        id: 'nt-ok',
        hlc: ok,
        data: JSON.stringify(record({ id: 'nt-ok', title: 'fine' }, { title: ok })),
      },
      { collection: 'unknown', id: 'u-1', hlc: ok, data: '{}' },
    ]);
    const result = await store.sync.pull();
    expect(result).toEqual({ applied: 1, skipped: { drift: 1, sealed: 1 }, held: 2 });
    expect((await store.collection('notes').list()).map((d) => d.id)).toEqual(['nt-ok']);
    expect(await store.collection('notes').get('nt-held')).toBeNull();
  });

  it('pullDocument merges every writer version without moving the cursor', async () => {
    const { store, adapter } = await signedInStore('A');
    await store.sync.pull();
    store.dispose();
    const cursorBefore = await adapter.get('_config', 'cursor');
    const other = server.apiToken('app');
    const clock = encodeHlc({ wallMs: Date.now() - 1_000, counter: 0, node: 'other' });
    server.seed(other, [
      {
        collection: 'n',
        id: 'nt-1',
        hlc: clock,
        data: JSON.stringify(record({ id: 'nt-1', title: 'theirs' }, { title: clock })),
      },
    ]);
    await store.sync.pullDocument('notes', 'nt-1');
    expect((await store.collection('notes').get('nt-1'))?.title).toBe('theirs');
    expect(await adapter.get('_config', 'cursor')).toEqual(cursorBefore);
  });

  it('backfills a collection defined after the first sync', async () => {
    const other = server.apiToken('app');
    const clock = encodeHlc({ wallMs: Date.now() - 1_000, counter: 0, node: 'other' });
    server.seed(other, [
      {
        collection: 'docs',
        id: 'd-1',
        hlc: clock,
        data: JSON.stringify({ ...record({ id: 'd-1' }, { body: clock }), text: undefined }),
      },
    ]);
    const { store, adapter } = await signedInStore('A', { collections: [notes] });
    await store.sync.pull();
    const other2 = server.apiToken('app');
    server.seed(other2, [
      {
        collection: 'n',
        id: 'nt-later',
        hlc: clock,
        data: JSON.stringify(record({ id: 'nt-later', title: 'x' }, { title: clock })),
      },
    ]);
    store.dispose();
    const upgraded = await Store.create({ adapter, collections: [notes, docs] });
    const before = server.requests.length;
    await upgraded.sync.pull();
    const backfill = server.requests
      .slice(before)
      .filter((r) => r.path.includes('collection=docs') && r.path.includes('cursor=0'));
    expect(backfill).toHaveLength(1);
    expect(await upgraded.collection('docs').get('d-1')).not.toBeNull();
    expect(await upgraded.collection('notes').get('nt-later')).not.toBeNull();
  });

  it('resync drops local state and pulls everything again', async () => {
    const { store, adapter } = await signedInStore('A');
    await store.collection('notes').create({ id: 'nt-1', title: 'a' });
    await store.sync.drain();
    server.offline = true;
    await store.collection('notes').create({ id: 'nt-local', title: 'unsynced' });
    await store.sync.drain().catch(() => {});
    expect(await store.sync.pending()).toBe(1);
    server.offline = false;
    const result = await store.sync.resync();
    expect(result.applied).toBe(1);
    expect((await store.collection('notes').list()).map((d) => d.id)).toEqual(['nt-1']);
    expect(await store.sync.pending()).toBe(0);
    expect(await adapter.get('_config', 'client')).not.toBeNull();
  });

  it('push re-sends every record', async () => {
    const { store } = await signedInStore('A');
    await store.collection('notes').create({ id: 'nt-1', title: 'a' });
    await store.sync.drain();
    const before = server.versionsOf('app', 'n', 'nt-1')[0]!.seq;
    await store.sync.push();
    expect(server.versionsOf('app', 'n', 'nt-1')[0]!.seq).toBeGreaterThan(before);
  });

  it('pulls on a realtime change and catches the cursor up to the server seq', async () => {
    const { store, adapter } = await signedInStore('A');
    await store.sync.pull();
    const other = server.apiToken('app');
    const clock = encodeHlc({ wallMs: Date.now() - 1_000, counter: 0, node: 'other' });
    const seq = server.seed(other, [
      {
        collection: 'n',
        id: 'nt-rt',
        hlc: clock,
        data: JSON.stringify(record({ id: 'nt-rt', title: 'rt' }, { title: clock })),
      },
    ]);
    await vi.waitFor(async () =>
      expect(await store.collection('notes').get('nt-rt')).not.toBeNull()
    );
    await vi.waitFor(async () => {
      const cursor = await adapter.get('_config', 'cursor');
      expect(cursor && !('enc' in cursor) ? cursor.fields.cursor : null).toBe(seq);
    });
  });
});

describe('encryption on the wire', () => {
  it('ships envelopes and partitions clients by key', async () => {
    const key1 = createWebCryptoCipher(await deriveEncryptionKey('one', 'app', 1_000));
    const key2 = createWebCryptoCipher(await deriveEncryptionKey('two', 'app', 1_000));
    const a = await signedInStore('A', { cipher: key1 });
    const b = await signedInStore('B', { cipher: key1 });
    const c = await signedInStore('C', { cipher: key2 });
    c.store.dispose();
    await a.store.collection('notes').create({ id: 'nt-1', title: 'secret' });
    await a.store.sync.drain();
    const version = server.versionsOf('app', 'n', 'nt-1')[0]!;
    expect(version.data.startsWith('pactenc$')).toBe(true);
    expect(version.data).not.toContain('secret');
    await vi.waitFor(async () => {
      expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('secret');
    });
    const result = await c.store.sync.pull();
    expect(result.skipped.sealed).toBeGreaterThanOrEqual(1);
    expect(await c.store.collection('notes').get('nt-1')).toBeNull();
  });
});

describe('blobs', () => {
  it('pushes and pulls blobs through the server', async () => {
    const makeBlobs = () => {
      const data = new Map<string, { bytes: Uint8Array; mime: string }>();
      return {
        has: async (h: string) => data.has(h),
        read: async (h: string) => data.get(h)?.bytes ?? null,
        mimeType: async (h: string) => data.get(h)?.mime ?? null,
        write: async (h: string, bytes: Uint8Array, mime: string) =>
          void data.set(h, { bytes, mime }),
        delete: async (h: string) => void data.delete(h),
        list: async () => Array.from(data.keys()),
        uriFor: (h: string) => (data.has(h) ? `mem://${h}` : null),
      };
    };
    const adapterA = new InMemoryAdapter();
    const a = await Store.create({ adapter: adapterA, collections: [notes], blobs: makeBlobs() });
    const begun = await a.sync.beginSignIn({
      url: server.origin,
      appId: 'app',
      deviceName: 'A',
      redirectUri: 'https://app.test/callback',
    });
    const redirect = server.authorize(begun.authorizeUrl, { username: 'alice', password: 'pw' });
    if ('error' in redirect) throw new Error(redirect.error);
    await a.sync.completeSignIn(redirect);
    const hash = await a.blobs.write(new TextEncoder().encode('hello'), 'text/plain');
    await a.blobs.push();

    const b = await Store.create({
      adapter: new InMemoryAdapter(),
      collections: [notes],
      blobs: makeBlobs(),
    });
    const begunB = await b.sync.beginSignIn({
      url: server.origin,
      appId: 'app',
      deviceName: 'B',
      redirectUri: 'https://app.test/callback',
    });
    const redirectB = server.authorize(begunB.authorizeUrl, { username: 'alice', password: 'pw' });
    if ('error' in redirectB) throw new Error(redirectB.error);
    await b.sync.completeSignIn(redirectB);
    await b.blobs.pull([hash]);
    expect(await b.blobs.has(hash)).toBe(true);
    expect(new TextDecoder().decode((await b.blobs.adapter!.read(hash))!)).toBe('hello');
    await expect(b.blobs.write(new Uint8Array(50 * 1024 * 1024 + 1), 'x')).rejects.toThrow(/50 MB/);
  });
});
