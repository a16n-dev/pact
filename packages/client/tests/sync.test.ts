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
import { dumpAdapter } from './fixtureSupport';
import { signIn } from './signIn';
import type { StoredRecord } from '../src/record';

const notes = defineCollection({
  name: 'notes',
  key: 'n',
  idPrefix: 'nt',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), tags: z.array(z.string()).default([]) }),
});

const docs = defineCollection({
  name: 'docs',
  idPrefix: 'd',
  merge: 'field',
  schema: (base) => base.extend({ body: yText() }),
});

const pages = defineCollection({
  name: 'pages',
  idPrefix: 'pg',
  merge: 'field',
  schema: (base) => base.extend({ title: yText(), body: yText() }),
});

const local = defineCollection({
  name: 'prefs',
  idPrefix: 'p',
  merge: 'field',
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

type Options = {
  adapter?: InMemoryAdapter;
  cipher?: DocCipher;
  collections?: any[];
  textPushDelayMs?: number;
};

async function signedInStore(deviceName: string, opts: Options = {}) {
  const adapter = opts.adapter ?? new InMemoryAdapter();
  const store = await Store.create({
    adapter,
    collections: opts.collections ?? [notes, docs, local],
    encryption: opts.cipher ? { cipher: opts.cipher } : undefined,
    textPushDelayMs: opts.textPushDelayMs,
  });
  await signIn(store, server, deviceName);
  await vi.waitFor(() => expect(server.openSockets('app')).toBeGreaterThan(0));
  return { store, adapter };
}

class SilentSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

// Holds every request until released, so a test can overlap work with a switch.
function heldNetwork() {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    await open;
    return server.fetch(...args);
  });
  return { release };
}

// Holds the first push until released, resolving `started` once it is in flight.
function heldPush() {
  let release!: () => void;
  let started!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (started = resolve));
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    if (String(args[0] instanceof Request ? args[0].url : args[0]).endsWith('/sync/push')) {
      started();
      await open;
      vi.stubGlobal('fetch', server.fetch);
    }
    return server.fetch(...args);
  });
  return { started: entered, release };
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
      access: 'write',
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
    // Realtime's open-time pull would otherwise meet the revoked token and
    // clear it before the second store reads it.
    await store.sync.pull();
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
    const a = await signedInStore('A', { textPushDelayMs: 50 });
    const b = await signedInStore('B', { textPushDelayMs: 50 });
    await a.store.collection('docs').create({ id: 'd-1', body: 'hello' });
    await a.store.sync.drain();
    await vi.waitFor(async () =>
      expect(await b.store.collection('docs').get('d-1')).not.toBeNull()
    );

    (await a.store.collection('docs').text('d-1', 'body')).insert(5, ' world');
    (await b.store.collection('docs').text('d-1', 'body')).insert(0, 'oh ');
    const t0 = Date.now();
    await vi.waitFor(
      async () => {
        expect(await a.store.sync.pending()).toBe(0);
        expect(await b.store.sync.pending()).toBe(0);
      },
      { timeout: 5000 }
    );
    console.error('ELAPSED', Date.now() - t0, await a.store.collection('docs').get('d-1'));
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

  it('merges concurrent string writes to a text field', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B');
    await a.store.collection('docs').create({ id: 'd-1', body: 'hello world' });
    await a.store.sync.drain();
    await vi.waitFor(async () =>
      expect(await b.store.collection('docs').get('d-1')).not.toBeNull()
    );

    await a.store.collection('docs').update('d-1', { body: 'hello brave world' });
    await b.store.collection('docs').update('d-1', { body: 'hello world!' });
    await settled(a.store);
    await settled(b.store);
    await settled(a.store);
    expect((await a.store.collection('docs').get('d-1'))?.body).toBe('hello brave world!');
    expect((await b.store.collection('docs').get('d-1'))?.body).toBe('hello brave world!');
  });

  it('rebases unpushed text edits onto a compaction from another device', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B', { textPushDelayMs: 60_000 });
    await a.store.collection('docs').create({ id: 'd-1', body: 'one two three' });
    await a.store.sync.drain();
    await vi.waitFor(async () =>
      expect(await b.store.collection('docs').get('d-1')).not.toBeNull()
    );
    // B stays offline so its edit is still queued when the compaction lands.
    b.store.dispose();
    await b.store.collection('docs').updateText('d-1', 'body', {
      base: 'one two three',
      next: 'one two three four',
    });
    await a.store.collection('docs').update('d-1', { body: 'zero one two three' });
    await a.store.collection('docs').compactText('d-1');
    await a.store.sync.drain();

    await b.store.sync.pull();
    expect((await b.store.collection('docs').get('d-1'))?.body).toBe('zero one two three four');
    await b.store.sync.drain();
    await a.store.sync.pull();
    expect((await a.store.collection('docs').get('d-1'))?.body).toBe('zero one two three four');
  });

  it('merges the same compaction made on two devices into one text', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B');
    await a.store.collection('docs').create({ id: 'd-1', body: 'hello' });
    await a.store.sync.drain();
    await vi.waitFor(async () =>
      expect(await b.store.collection('docs').get('d-1')).not.toBeNull()
    );
    a.store.dispose();
    b.store.dispose();
    await a.store.collection('docs').compactText('d-1');
    await b.store.collection('docs').compactText('d-1');
    await a.store.sync.drain();
    await b.store.sync.drain();
    await a.store.sync.pull();
    await b.store.sync.pull();
    expect((await a.store.collection('docs').get('d-1'))?.body).toBe('hello');
    expect((await b.store.collection('docs').get('d-1'))?.body).toBe('hello');
  });

  it('keeps a write made while its document is being pushed queued', async () => {
    const { store } = await signedInStore('A');
    store.dispose();
    const push = heldPush();
    await store.collection('notes').create({ id: 'nt-1', title: 'first' });
    await push.started;
    await store.collection('notes').update('nt-1', { title: 'second' });
    push.release();
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0));
    const versions = server.versionsOf('app', 'n', 'nt-1');
    expect(versions.map((v) => JSON.parse(v.data).fields.title)).toContain('second');
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

  it('waits the configured delay before pushing text edits', async () => {
    const { store } = await signedInStore('A', { textPushDelayMs: 50 });
    store.dispose();
    await store.collection('docs').create({ id: 'd-1', body: 'a' });
    await store.sync.drain();
    await store.collection('docs').updateText('d-1', 'body', { base: 'a', next: 'ab' });
    expect(await store.sync.pending()).toBe(1);
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0), { timeout: 500 });
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
    await store.sync.drain().catch(() => {});
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
    // Realtime's open-time pull and drain would otherwise race the resync.
    store.dispose();
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

describe.each([
  { name: 'unencrypted', phrase: null },
  { name: 'with a shared key', phrase: 'shared' },
])('text edits around a compaction ($name)', ({ phrase }) => {
  let cipher: DocCipher | undefined;

  beforeEach(async () => {
    cipher = phrase
      ? createWebCryptoCipher(await deriveEncryptionKey(phrase, 'app', 1_000))
      : undefined;
  });

  // Realtime would pull and push on its own schedule, so these devices sync
  // only when the test says.
  async function device(name: string, opts: Options = {}) {
    const signedIn = await signedInStore(name, { ...opts, cipher });
    signedIn.store.dispose();
    return { ...signedIn, docs: signedIn.store.collection('docs') };
  }

  async function bodyOf(store: Store<any>): Promise<string | undefined> {
    return ((await store.collection('docs').get('d-1')) as { body: string } | null)?.body;
  }

  it('replays an edit pushed after a compaction it had not seen, across a reload', async () => {
    const a = await device('A');
    const b = await device('B', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await b.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await a.docs.compactText('d-1');
    await a.store.sync.drain();
    await b.store.sync.drain();

    const reopened = await Store.create({
      adapter: b.adapter,
      collections: [notes, docs, local],
      encryption: cipher ? { cipher } : undefined,
    });
    reopened.dispose();
    await reopened.sync.pull();
    expect(await bodyOf(reopened)).toBe('one two');
    await reopened.sync.drain();
    await a.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('one two');
  });

  it('carries over an edit pushed while another device was compacting', async () => {
    const a = await device('A');
    const b = await device('B', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await b.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    const aToken = (await a.store.sync.credentials())!.token;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (input.endsWith('/sync/push') && auth === `Bearer ${aToken}`) {
        throw new TypeError('fetch failed');
      }
      return server.fetch(input, init);
    });
    await a.docs.compactText('d-1');
    await b.store.sync.drain();
    vi.stubGlobal('fetch', server.fetch);
    await a.store.sync.drain();

    await b.store.sync.pull();
    await a.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('one two');
    await a.store.sync.drain();
    await b.store.sync.pull();
    expect(await bodyOf(b.store)).toBe('one two');
  });

  it('replays a queued edit across compactions by two other devices', async () => {
    const a = await device('A');
    const b = await device('B');
    const c = await device('C', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await c.store.sync.pull();
    await c.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await a.docs.update('d-1', { body: 'zero one' });
    await a.docs.compactText('d-1');
    await a.store.sync.drain();
    await b.store.sync.pull();
    await b.docs.compactText('d-1');
    await b.store.sync.drain();
    await c.store.sync.drain();

    await c.store.sync.pull();
    expect(await bodyOf(c.store)).toBe('zero one two');
    await c.store.sync.drain();
    await a.store.sync.pull();
    await b.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('zero one two');
    expect(await bodyOf(b.store)).toBe('zero one two');
  });

  it('replays only the edits a push had not sent when a compaction saw that push', async () => {
    const a = await device('A', { textPushDelayMs: 60_000 });
    const b = await device('B');
    const key = cipher ? `docs@${await cipher.keyId()}` : 'docs';
    const push = heldPush();
    await a.docs.create({ id: 'd-1', body: 'one' });
    await push.started;
    await a.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    push.release();
    await vi.waitFor(() => expect(server.versionsOf('app', key, 'd-1')).toHaveLength(1));
    await b.store.sync.pull();
    await b.docs.compactText('d-1');
    await b.store.sync.drain();

    await a.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('one two');
  });

  it('replays an edit the server refused for being behind a compaction before pushing it again', async () => {
    const a = await device('A');
    const b = await device('B', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await a.docs.compactText('d-1');
    await a.store.sync.drain();
    await b.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await b.store.sync.drain();
    expect(server.refusals).toBe(1);
    expect(await b.store.sync.pending()).toBe(0);

    await a.docs.updateText('d-1', 'body', { base: 'one', next: 'zero one' });
    await a.store.sync.drain();
    await a.store.sync.pull();
    await b.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('zero one two');
    expect(await bodyOf(b.store)).toBe('zero one two');
  });

  it('keeps every text field of a compaction that lost to a concurrent one', async () => {
    const collections = [notes, docs, local, pages];
    const a = await device('A', { collections });
    const b = await device('B', { collections });
    const pagesOf = (store: Store<any>) => store.collection('pages');
    await pagesOf(a.store).create({ id: 'pg-1', title: 'title', body: 'body' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await pagesOf(a.store).updateText('pg-1', 'title', { base: 'title', next: 'title one' });
    await pagesOf(a.store).compactText('pg-1');
    await pagesOf(b.store).updateText('pg-1', 'body', { base: 'body', next: 'body two' });
    await pagesOf(b.store).compactText('pg-1');
    await a.store.sync.drain();
    await b.store.sync.drain();

    await a.store.sync.pull();
    for (const store of [a.store, b.store]) {
      expect(await pagesOf(store).get('pg-1')).toMatchObject({
        title: 'title one',
        body: 'body two',
      });
    }
  });

  it('takes in an edit that reaches the server between the pull and push of a compaction', async () => {
    const a = await device('A');
    const b = await device('B', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await a.docs.compactText('d-1');
    await b.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    const aToken = (await a.store.sync.credentials())!.token;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (input.endsWith('/sync/push') && auth === `Bearer ${aToken}`) {
        vi.stubGlobal('fetch', server.fetch);
        await b.store.sync.drain();
      }
      return server.fetch(input, init);
    });
    await a.store.sync.drain();
    expect(server.refusals).toBe(1);

    await b.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('one two');
    expect(await bodyOf(b.store)).toBe('one two');
    const key = cipher ? `docs@${await cipher.keyId()}` : 'docs';
    expect(server.versionsOf('app', key, 'd-1')).toHaveLength(2);
  });

  it('holds back a compaction until it can merge every version on the server', async () => {
    const a = await device('A');
    const b = await device('B', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    // B's clock runs ahead of A's drift bound, so A skips B's version.
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now + 600_000);
    await b.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await b.store.sync.drain();
    vi.setSystemTime(now);
    await a.docs.compactText('d-1');
    await a.store.sync.drain();
    expect(server.refusals).toBeGreaterThan(0);
    expect(await a.store.sync.pending()).toBe(1);

    vi.setSystemTime(now + 600_000);
    await a.store.sync.drain();
    await b.store.sync.pull();
    expect(await bodyOf(a.store)).toBe('one two');
    expect(await bodyOf(b.store)).toBe('one two');
  });

  it('turns the plaintext text base an older build queued into a sealed one', async () => {
    const a = await device('A');
    const b = await device('B', { textPushDelayMs: 60_000 });
    await a.docs.create({ id: 'd-1', body: 'zqx_ one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await b.docs.updateText('d-1', 'body', { base: 'zqx_ one', next: 'zqx_ one two' });
    const [queued] = await b.adapter.getAll('_outbox');
    const entry = queued!.record as StoredRecord;
    await b.adapter.put('_outbox', queued!.id, {
      ...entry,
      fields: { ...entry.fields, textBase: { body: 'zqx_ one' } },
    });
    for (const { id } of await b.adapter.getAll('_textBases')) {
      await b.adapter.delete('_textBases', id);
    }

    // Realtime's open-time drain would push the edit before the compaction lands.
    vi.stubGlobal('WebSocket', SilentSocket);
    const reopened = await Store.create({
      adapter: b.adapter,
      collections: [notes, docs, local],
      encryption: cipher ? { cipher } : undefined,
    });
    reopened.dispose();
    const [upgraded] = await b.adapter.getAll('_outbox');
    expect((upgraded!.record as StoredRecord).fields).not.toHaveProperty('textBase');

    if (cipher) expect(JSON.stringify(await dumpAdapter(b.adapter))).not.toMatch(/zqx_/);
    await a.docs.compactText('d-1');
    await a.store.sync.drain();
    await reopened.sync.pull();
    expect(await bodyOf(reopened)).toBe('zqx_ one two');
  });
});

describe('a server without generations', () => {
  async function device(name: string) {
    const signedIn = await signedInStore(name, { textPushDelayMs: 60_000 });
    signedIn.store.dispose();
    return { ...signedIn, docs: signedIn.store.collection('docs') };
  }

  it('takes every push, so a client syncs as it did before generations', async () => {
    server.ignoresGenerations = true;
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (input.endsWith('/sync/push')) sent.push(...JSON.parse(String(init?.body)).documents);
      return server.fetch(input, init);
    });
    const a = await device('A');
    const b = await device('B');
    await a.docs.create({ id: 'd-1', body: 'one' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await a.docs.compactText('d-1');
    await a.store.sync.drain();
    await b.docs.updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await b.store.sync.drain();
    expect(await b.store.sync.pending()).toBe(0);
    expect(sent).toContainEqual(expect.objectContaining({ generation: 0 }));

    await b.store.sync.pull();
    await b.store.sync.drain();
    await a.store.sync.pull();
    expect((await a.docs.get('d-1'))?.body).toBe('one two');
  });
});

describe('fake server generations', () => {
  type Generation = { generation?: number; seenSeq?: number };

  async function pushAs(token: string, documents: unknown[]) {
    const res = await server.fetch(`${server.origin}/sync/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { seq: number; rejected?: Array<{ id: string; code: string }> },
    };
  }

  function at(id: string, data: string, generation: Generation = {}) {
    return { collection: 'notes', id, hlc: '1', data, ...generation };
  }

  function writers() {
    return { a: server.apiToken('app'), other: server.apiToken('app') };
  }

  it('rejects a version behind another writer and still writes the rest of the push', async () => {
    const { a, other } = writers();
    const { body: first } = await pushAs(other, [at('n1', 'compacted', { generation: 1 })]);
    const { body } = await pushAs(a, [
      at('n0', 'fresh', { generation: 0 }),
      at('n1', 'stale', { generation: 0 }),
      at('n2', 'x'),
    ]);
    expect(body.rejected).toEqual([{ collection: 'notes', id: 'n1', code: 'generation_behind' }]);
    expect(body.seq).toBe(first.seq + 2);
    expect(server.versionsOf('app', 'notes', 'n2')[0]!.seq).toBe(first.seq + 2);
    expect((await pushAs(a, [at('n1', 'same', { generation: 1 })])).body.rejected).toEqual([]);
    const { body: all } = await pushAs(a, [
      at('n0', 'stale', { generation: 0 }),
      at('n1', 'y', {}),
    ]);
    expect(all.rejected).toEqual([]);
    const { body: refused } = await pushAs(a, [at('n1', 'stale', { generation: 0 })]);
    expect(refused.rejected).toHaveLength(1);
    expect(refused.seq).toBe(all.seq);
  });

  it('rejects a compaction unless it saw every other version', async () => {
    const { a, other } = writers();
    const { body: edit } = await pushAs(other, [at('n1', 'edit')]);
    const blind = { generation: 1, seenSeq: edit.seq - 1 };
    expect((await pushAs(a, [at('n1', 'blind', blind)])).body.rejected).toHaveLength(1);
    const seen = { generation: 1, seenSeq: edit.seq };
    expect((await pushAs(a, [at('n1', 'seen', seen)])).body.rejected).toEqual([]);
    expect((await pushAs(a, [at('n1', 'retried', seen)])).body.rejected).toEqual([]);
    expect((await pushAs(other, [at('n1', 'theirs', seen)])).body.rejected).toHaveLength(1);
  });

  it('validates generations', async () => {
    expect((await pushAs(writers().a, [at('n1', 'x', { seenSeq: 0 })])).status).toBe(400);
  });

  it('reports no rejections when it ignores generations', async () => {
    server.ignoresGenerations = true;
    const other = server.apiToken('app');
    await pushAs(other, [at('n1', 'compacted', { generation: 1 })]);
    const { body } = await pushAs(server.apiToken('app'), [at('n1', 'stale', { generation: 0 })]);
    expect(body).not.toHaveProperty('rejected');
  });
});

describe('key lenses on the wire', () => {
  const cipherFor = async (phrase: string) =>
    createWebCryptoCipher(await deriveEncryptionKey(phrase, 'app', 1_000));

  it('ships envelopes under the lens key and partitions clients by key', async () => {
    const key1 = await cipherFor('one');
    const keyId = await key1.keyId();
    const a = await signedInStore('A', { cipher: key1 });
    const b = await signedInStore('B', { cipher: await cipherFor('one') });
    const c = await signedInStore('C', { cipher: await cipherFor('two') });
    c.store.dispose();
    await a.store.collection('notes').create({ id: 'nt-1', title: 'secret' });
    await a.store.sync.drain();
    expect(server.versionsOf('app', 'n', 'nt-1')).toEqual([]);
    const version = server.versionsOf('app', `n@${keyId}`, 'nt-1')[0]!;
    expect(version.data.startsWith('pactenc$')).toBe(true);
    expect(version.data).not.toContain('secret');
    await vi.waitFor(async () => {
      expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('secret');
    });
    await c.store.sync.pull();
    expect(await c.store.collection('notes').get('nt-1')).toBeNull();
  });

  it('catches a lens up on what it missed while another was active', async () => {
    const a = await signedInStore('A', { cipher: await cipherFor('one') });
    const b = await signedInStore('B');
    b.store.dispose();
    await a.store.collection('notes').create({ id: 'nt-1', title: 'first' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    expect(await b.store.collection('notes').get('nt-1')).toBeNull();

    await b.store.encryption.setKey(await cipherFor('one'));
    await b.store.sync.pull();
    expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('first');

    await b.store.encryption.setKey(null);
    await a.store.collection('notes').update('nt-1', { title: 'second' });
    await a.store.sync.drain();
    await b.store.sync.pull();
    await b.store.encryption.setKey(await cipherFor('one'));
    await b.store.sync.pull();
    expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('second');
  });

  it('moves a lens for every device holding the key', async () => {
    const a = await signedInStore('A');
    const b = await signedInStore('B', { cipher: await cipherFor('one') });
    await a.store.collection('notes').create({ id: 'nt-1', title: 'plain' });
    await a.store.encryption.moveToKey(await cipherFor('one'));
    await a.store.sync.drain();
    await vi.waitFor(async () => {
      expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('plain');
    });
    const plain = await signedInStore('C');
    await plain.store.sync.pull();
    expect(await plain.store.collection('notes').get('nt-1')).toBeNull();
  });

  it('switches into a lens that holds versions for a newer build', async () => {
    const { store } = await signedInStore('A');
    const ok = encodeHlc({ wallMs: Date.now() - 1_000, counter: 0, node: 'other' });
    server.seed(server.apiToken('app'), [
      {
        collection: 'n',
        id: 'nt-held',
        hlc: ok,
        data: JSON.stringify({
          ...record({ id: 'nt-held', title: 'x' }, { title: ok }),
          schemaVersion: 9,
        }),
      },
    ]);
    expect((await store.sync.pull()).held).toBe(1);
    await store.encryption.setKey(await cipherFor('one'));
    await store.encryption.setKey(null);
    await store.collection('notes').create({ id: 'nt-1', title: 'after' });
    expect((await store.collection('notes').get('nt-1'))?.title).toBe('after');
  });

  it('lets pulls in flight land in the lens they started in', async () => {
    const { store } = await signedInStore('A');
    const ok = encodeHlc({ wallMs: Date.now() - 1_000, counter: 0, node: 'other' });
    server.seed(
      server.apiToken('app'),
      ['nt-1', 'nt-2', 'nt-3'].map((id) => ({
        collection: 'n',
        id,
        hlc: ok,
        data: JSON.stringify(record({ id, title: id }, { title: ok })),
      }))
    );
    const cipher = await cipherFor('one');
    const network = heldNetwork();
    const pulled = store.sync.pull();
    const fetched = store.sync.pullDocument('notes', 'nt-1');
    const switched = store.encryption.setKey(cipher);
    await new Promise((resolve) => setTimeout(resolve, 20));
    network.release();
    await Promise.all([pulled, fetched, switched]);
    expect(await store.collection('notes').list()).toEqual([]);
    await store.encryption.setKey(null);
    expect((await store.collection('notes').list()).map((d) => d.id).sort()).toEqual([
      'nt-1',
      'nt-2',
      'nt-3',
    ]);
  });

  it('lands a fetched document in the lens it was requested from', async () => {
    const a = await signedInStore('A', { cipher: await cipherFor('one') });
    const b = await signedInStore('B', { cipher: await cipherFor('one') });
    b.store.dispose();
    await a.store.collection('notes').create({ id: 'nt-1', title: 'sealed' });
    await a.store.sync.drain();
    const network = heldNetwork();
    const fetched = b.store.sync.pullDocument('notes', 'nt-1');
    const switched = b.store.encryption.setKey(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    network.release();
    await Promise.all([fetched, switched]);
    await b.store.encryption.setKey(await cipherFor('one'));
    expect((await b.store.collection('notes').get('nt-1'))?.title).toBe('sealed');
  });

  it('pushes writes queued in a lens after switching away from it', async () => {
    const a = await signedInStore('A', { cipher: await cipherFor('one') });
    const keyId = await (await cipherFor('one')).keyId();
    a.store.dispose();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await a.store.collection('notes').create({ id: 'nt-1', title: 'queued' });
    await a.store.encryption.setKey(null);
    expect(await a.store.sync.pending()).toBe(1);
    vi.stubGlobal('fetch', server.fetch);
    await a.store.sync.drain();
    expect(server.versionsOf('app', `n@${keyId}`, 'nt-1')).toHaveLength(1);
  });

  it('pushes text queued in a lens after switching away from it', async () => {
    const a = await signedInStore('A', { cipher: await cipherFor('one') });
    const keyId = await (await cipherFor('one')).keyId();
    a.store.dispose();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await a.store.collection('docs').create({ id: 'd-1', body: 'queued' });
    await a.store
      .collection('docs')
      .compactText('d-1')
      .catch(() => {});
    await a.store.encryption.setKey(null);
    vi.stubGlobal('fetch', server.fetch);
    await a.store.sync.drain();
    expect(server.versionsOf('app', `docs@${keyId}`, 'd-1')).toHaveLength(1);
    expect(await a.store.sync.pending()).toBe(0);
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
