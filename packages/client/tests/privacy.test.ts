import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { defineCollection } from '../src/collection';
import { Store } from '../src/store';
import { yText } from '../src/yjs';
import { FakeServer } from './fakeServer';
import { APP_ID, cipherFor, dumpAdapter, setUpServer, signIn } from './fixtureSupport';

const MARKER = /zqx_/i;

const journal = defineCollection({
  name: 'journal',
  key: 'j',
  idPrefix: 'jr',
  merge: 'field',
  schema: (base) =>
    base.extend({
      zqx_title: z.string(),
      zqx_tags: z.array(z.string()),
      zqx_body: yText(),
    }),
});

let server: FakeServer;
let sent: string[];

beforeEach(() => {
  server = new FakeServer();
  setUpServer(server);
  sent = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    sent.push(String(input instanceof Request ? input.url : input));
    if (init?.body !== undefined && init.body !== null) sent.push(String(init.body));
    return server.fetch(input, init);
  });
  vi.stubGlobal(
    'WebSocket',
    class extends server.WebSocket {
      constructor(url: string) {
        sent.push(url);
        super(url);
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function encryptedStore() {
  const adapter = new InMemoryAdapter();
  const cipher = await cipherFor({ password: 'pw', salt: 'salt', iterations: 1_000 });
  const store = await Store.create({
    adapter,
    collections: [journal],
    encryption: { cipher },
    textPushDelayMs: 0,
  });
  await signIn(store, server);
  return { store, adapter, entries: store.collection('journal') };
}

async function adapterContents(adapter: InMemoryAdapter): Promise<string> {
  return JSON.stringify(await dumpAdapter(adapter));
}

describe('an encrypted store', () => {
  it('sends no field name or value to the server and keeps none at rest', async () => {
    const { store, adapter, entries } = await encryptedStore();
    await entries.create({
      id: 'jr-1',
      zqx_title: 'zqx_ title',
      zqx_tags: ['zqx_ tag'],
      zqx_body: 'zqx_ body',
    });
    await entries.update('jr-1', { zqx_title: 'zqx_ renamed' });
    const text = await entries.text('jr-1', 'zqx_body');
    text.insert(0, 'zqx_ typed ');
    await entries.updateText('jr-1', 'zqx_body', {
      base: 'zqx_ typed zqx_ body',
      next: 'zqx_ typed zqx_ body zqx_ more',
    });
    await entries.create({
      id: 'jr-2',
      zqx_title: 'zqx_ doomed',
      zqx_tags: [],
      zqx_body: 'zqx_ gone',
    });
    await entries.delete('jr-2');
    await entries.compactText('jr-1');
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0));
    await store.sync.push();
    await store.sync.pull();

    const pushed = server.versionsOf(APP_ID, `j@${await keyIdOf(adapter)}`, 'jr-1');
    expect(pushed).toHaveLength(1);
    expect(sent.some((entry) => entry.includes('/sync/push'))).toBe(true);
    expect(sent.filter((entry) => MARKER.test(entry))).toEqual([]);
    expect(await adapterContents(adapter)).not.toMatch(MARKER);
    store.dispose();
  });

  it.fails(
    'keeps text field values out of the adapter while edits wait in the outbox',
    async () => {
      const { store, adapter, entries } = await encryptedStore();
      await entries.create({
        id: 'jr-1',
        zqx_title: 'title',
        zqx_tags: [],
        zqx_body: 'zqx_ synced body',
      });
      await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0));
      server.offline = true;
      await entries.update('jr-1', { zqx_body: 'edited offline' });
      expect(await store.sync.pending()).toBe(1);
      expect(await adapterContents(adapter)).not.toMatch(/zqx_ synced body/);
      store.dispose();
    }
  );
});

async function keyIdOf(adapter: InMemoryAdapter): Promise<string> {
  const keys = await adapter.listCollections();
  const lensed = keys.find((key) => key.startsWith('j@'));
  if (!lensed) throw new Error('No lensed collection');
  return lensed.slice(2);
}
