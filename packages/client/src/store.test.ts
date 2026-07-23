import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store, type SeedSet, type StoreDomain } from './store';
import type { StoreSyncConfig } from './store/options';
import { InMemoryAdapter } from './adapters/memoryAdapter';
import { defineCollection } from './collection';
import { LOCAL_AUTHOR_ID, SYSTEM_AUTHOR_ID } from './system';
import type { BaseDocument } from './types';
import type { BlobAdapter } from './blobs/blobAdapter';
import { blobFields } from './blobs/blobFields';
import { createWebCryptoCipher } from './crypto/webCrypto';
import { decryptDoc, encryptDoc, isEncryptedDoc } from './crypto/docCrypto';

type Widget = BaseDocument & { name: string; upgraded?: boolean };

const SYNC = { syncUrl: 'https://sync.test', syncToken: 'tok' };

// The tests' one domain collection. `id` is loosened from the prefix-dash
// convention because fixtures use short literal ids ('w1', 'w-seed', …).
const widgetsDef = defineCollection({
  name: 'widgets',
  idPrefix: 'w',
  schema: (base) =>
    base.extend({
      id: z.string(),
      name: z.string(),
      upgraded: z.boolean().optional(),
      note: z.string().nullable().optional(),
    }),
});

function mkDoc(id: string, name: string, updatedAt: string, by = 'us/1'): Widget {
  return {
    id,
    schemaVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    createdBy: by,
    updatedBy: by,
    deletedAt: null,
    deletedBy: null,
    name,
  };
}

function setup(domain: Partial<StoreDomain> = {}, options?: StoreSyncConfig) {
  const adapter = new InMemoryAdapter();
  const store = new Store({ adapter, collections: [widgetsDef], ...domain, sync: options });
  return { adapter, store };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Store CRUD + tombstones', () => {
  it('create stamps base fields, persists, and emits a change', async () => {
    const { store } = setup();
    const onChange = vi.fn();
    store.on('change', onChange);
    await store.author.set('us/1');
    const w = await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    expect(w).toMatchObject({
      id: 'w1',
      name: 'Alpha',
      createdBy: 'us/1',
      updatedBy: 'us/1',
      deletedAt: null,
    });
    expect(await store.collection<Widget>('widgets').get('w1')).toMatchObject({ id: 'w1', name: 'Alpha' });
    expect(onChange).toHaveBeenCalledWith('widgets');
  });

  it('create generates a prefixed id when none is supplied', async () => {
    const { store } = setup();
    await store.author.set('us/1');
    const w = await store.collection<Widget>('widgets').create({ name: 'NoId' });
    expect(w.id).toMatch(/^w-[A-Za-z0-9]{10}$/);
    expect(await store.collection<Widget>('widgets').get(w.id)).toMatchObject({ name: 'NoId' });
    const many = await store.collection<Widget>('widgets').createMany([{ name: 'A' }, { id: 'w9', name: 'B' }]);
    expect(many[0].id).toMatch(/^w-/);
    expect(many[1].id).toBe('w9');
  });

  it('update preserves createdAt/createdBy and bumps the editor', async () => {
    const { store } = setup();
    await store.author.set('us/1');
    const created = await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    await store.author.set('us/2');
    const updated = await store.collection<Widget>('widgets').update('w1', { name: 'Beta' });
    expect(updated.name).toBe('Beta');
    expect(updated.createdBy).toBe('us/1');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedBy).toBe('us/2');
  });

  it('upsert creates when absent, updates when present, revives tombstones', async () => {
    const { store } = setup();
    await store.author.set('us/1');
    // Absent → create.
    const created = await store.collection<Widget>('widgets').upsert({ id: 'w1', name: 'Alpha' });
    expect(created).toMatchObject({ id: 'w1', name: 'Alpha', createdBy: 'us/1' });
    // Present → update: createdAt/createdBy survive, editor bumps.
    await store.author.set('us/2');
    const updated = await store.collection<Widget>('widgets').upsert({ id: 'w1', name: 'Beta' });
    expect(updated.name).toBe('Beta');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.createdBy).toBe('us/1');
    expect(updated.updatedBy).toBe('us/2');
    // Soft-deleted → revived as a fresh doc.
    await store.collection('widgets').delete('w1');
    const revived = await store.collection<Widget>('widgets').upsert({ id: 'w1', name: 'Gamma' });
    expect(revived.deletedAt).toBeNull();
    expect(revived.createdBy).toBe('us/2');
    expect(await store.collection<Widget>('widgets').get('w1')).toMatchObject({ name: 'Gamma' });
  });

  it('delete soft-deletes; get/list hide it but getIncludingDeleted returns it', async () => {
    const { store } = setup();
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    await store.collection<Widget>('widgets').create({ id: 'w2', name: 'Beta' });
    await store.collection('widgets').delete('w2');

    expect(await store.collection<Widget>('widgets').get('w2')).toBeNull();
    expect((await store.collection<Widget>('widgets').list()).map((w) => w.id)).toEqual(['w1']);
    expect((await store.collection<Widget>('widgets').getMany(['w1', 'w2'])).map((w) => w.id)).toEqual(['w1']);

    const tomb = await store.collection<Widget>('widgets').get('w2', { includeDeleted: true });
    expect(tomb?.deletedAt).not.toBeNull();
    expect(tomb?.deletedBy).toBe('us/1');
  });
});

describe('Store collection registry (schemas define collections)', () => {
  it('rejects access to collections with no definition', async () => {
    const { store } = setup();
    await store.author.set('us/1');
    // The handle is the only doc entry point, and it throws at creation.
    expect(() => store.collection('gadgets' as never)).toThrow(/Unknown collection/);
    expect(() => store.collection<Widget>('gadgets')).toThrow(/Unknown collection/);
  });

  it('validates writes against the collection schema', async () => {
    const { store } = setup();
    await store.author.set('us/1');
    await expect(
      store.collection<Widget>('widgets').create({ id: 'w1', name: 42 } as unknown as { name: string })
    ).rejects.toThrow();
  });

  it('still allows internal _* bookkeeping collections without definitions', async () => {
    const { adapter, store } = setup();
    await store.author.set('us/1'); // writes _config/author
    expect(await adapter.get('_config', 'author')).toMatchObject({ authorId: 'us/1' });
  });

  it('rejects reserved and duplicate collection names at construction', () => {
    // A reserved name now fails at definition time (the key defaults to it) …
    expect(() => defineCollection({ name: '_secret', idPrefix: 'x', schema: (b) => b })).toThrow(
      /reserved/
    );
    // … and the Store still rejects a hand-built definition that sneaks one in.
    const internal = { ...widgetsDef, name: '_secret', key: 'ok' };
    expect(() => new Store({ adapter: new InMemoryAdapter(), collections: [internal] })).toThrow(
      /reserved/
    );
    const dupe = defineCollection({ name: 'widgets', idPrefix: 'q', schema: (b) => b });
    expect(
      () => new Store({ adapter: new InMemoryAdapter(), collections: [widgetsDef, dupe] })
    ).toThrow(/Duplicate/);
  });

  it('rejects reserved and duplicate collection keys', () => {
    expect(() =>
      defineCollection({ name: 'secret', key: '_secret', idPrefix: 'x', schema: (b) => b })
    ).toThrow(/reserved/);
    const a = defineCollection({ name: 'alpha', key: 'c1', idPrefix: 'a', schema: (b) => b });
    const b = defineCollection({ name: 'beta', key: 'c1', idPrefix: 'b', schema: (b) => b });
    expect(() => new Store({ adapter: new InMemoryAdapter(), collections: [a, b] })).toThrow(
      /Duplicate collection key/
    );
  });
});

describe('Store migrate-on-read', () => {
  it('upgrades a stale doc on read and lazily writes it back', async () => {
    const migratingWidgets = defineCollection({
      name: 'widgets',
      idPrefix: 'w',
      migrations: {
        current: 2,
        migrations: [{ from: 1, to: 2, up: (d: Widget) => ({ ...d, upgraded: true }) }],
      },
      schema: (base) =>
        base.extend({ id: z.string(), name: z.string(), upgraded: z.boolean().optional() }),
    });
    const { adapter, store } = setup({ collections: [migratingWidgets] });
    await adapter.put('widgets', mkDoc('w1', 'X', '2026-01-01T00:00:00.000Z'));

    const got = await store.collection<Widget>('widgets').get('w1');
    expect(got?.schemaVersion).toBe(2);
    expect(got?.upgraded).toBe(true);

    // write-back is fire-and-forget; let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    const raw = await adapter.get<Widget>('widgets', 'w1');
    expect(raw?.schemaVersion).toBe(2);
  });
});

describe('Store author flow', () => {
  it('setAuthor records the id, writes _config/author, and runs the domain hook', async () => {
    const hook = vi.fn(async () => {});
    const { adapter, store } = setup({ onSetAuthor: hook });
    await store.author.set('us/1');

    expect(await store.author.get()).toBe('us/1');
    expect(hook).toHaveBeenCalledWith(store, 'us/1');
    expect(await adapter.get('_config', 'author')).toMatchObject({ authorId: 'us/1' });
  });

  it('setAuthor rejects the system and local sentinel ids', async () => {
    const { store } = setup();
    await expect(store.author.set(SYSTEM_AUTHOR_ID)).rejects.toThrow();
    await expect(store.author.set(LOCAL_AUTHOR_ID)).rejects.toThrow();
  });

  it('reassignLocalAuthor moves local-authored docs (incl. tombstone deletedBy) to a real id', async () => {
    const { adapter, store } = setup();
    const w = await store.collection<Widget>('widgets').create({ id: 'w1', name: 'X' });
    expect(w.createdBy).toBe(LOCAL_AUTHOR_ID);
    await store.collection<Widget>('widgets').create({ id: 'w2', name: 'Y' });
    await store.collection('widgets').delete('w2'); // soft-deleted while local: deletedBy === _local

    await store.author.reassignLocal('us/9');

    const after = await adapter.get<Widget>('widgets', 'w1');
    expect(after?.createdBy).toBe('us/9');
    expect(after?.updatedBy).toBe('us/9');

    const tomb = await adapter.get<Widget>('widgets', 'w2');
    expect(tomb?.createdBy).toBe('us/9');
    expect(tomb?.deletedBy).toBe('us/9');
  });
});

describe('Store pull (last-write-wins)', () => {
  it('applies a server doc newer than the local copy and emits', async () => {
    const { adapter, store } = setup({}, SYNC);
    const onChange = vi.fn();
    store.on('change', onChange);
    await adapter.put('widgets', mkDoc('w1', 'old', '2026-01-01T00:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          documents: [
            {
              id: 'w1',
              collection: 'widgets',
              updatedAt: '2026-05-05T00:00:00.000Z',
              data: mkDoc('w1', 'new', '2026-05-05T00:00:00.000Z'),
            },
          ],
          cursor: 1,
        })
      )
    );

    const applied = await store.collection<Widget>('widgets').pullAll();
    expect(applied).toHaveLength(1);
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('new');
    expect(onChange).toHaveBeenCalledWith('widgets');
  });

  it('skips a server doc older than a newer local edit, and does not emit', async () => {
    const { adapter, store } = setup({}, SYNC);
    const onChange = vi.fn();
    store.on('change', onChange);
    await adapter.put('widgets', mkDoc('w1', 'local-new', '2026-05-05T00:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          documents: [
            {
              id: 'w1',
              collection: 'widgets',
              updatedAt: '2026-01-01T00:00:00.000Z',
              data: mkDoc('w1', 'server-old', '2026-01-01T00:00:00.000Z'),
            },
          ],
          cursor: 1,
        })
      )
    );

    const applied = await store.collection<Widget>('widgets').pullAll();
    expect(applied).toHaveLength(0);
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('local-new');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies on a timestamp tie (incoming wins)', async () => {
    const { adapter, store } = setup({}, SYNC);
    await adapter.put('widgets', mkDoc('w1', 'local', '2026-05-05T00:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          documents: [
            {
              id: 'w1',
              collection: 'widgets',
              updatedAt: '2026-05-05T00:00:00.000Z',
              data: mkDoc('w1', 'server', '2026-05-05T00:00:00.000Z'),
            },
          ],
          cursor: 1,
        })
      )
    );

    const applied = await store.collection<Widget>('widgets').pullAll();
    expect(applied).toHaveLength(1);
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('server');
  });

  it('drains every page, advancing the cursor until hasMore is false', async () => {
    const { store } = setup({}, SYNC);
    const pageFor = (cursor: number) => {
      // Two full pages (w1@cursor 0 -> 1, w2@cursor 1 -> 2) then an empty tail.
      if (cursor === 0) {
        return {
          documents: [
            {
              id: 'w1',
              collection: 'widgets',
              updatedAt: '2026-05-05T00:00:00.000Z',
              data: mkDoc('w1', 'page1', '2026-05-05T00:00:00.000Z'),
            },
          ],
          cursor: 1,
          hasMore: true,
        };
      }
      if (cursor === 1) {
        return {
          documents: [
            {
              id: 'w2',
              collection: 'widgets',
              updatedAt: '2026-05-05T00:00:00.000Z',
              data: mkDoc('w2', 'page2', '2026-05-05T00:00:00.000Z'),
            },
          ],
          cursor: 2,
          hasMore: false,
        };
      }
      return { documents: [], cursor, hasMore: false };
    };
    const fetchMock = vi.fn(async (url: unknown) => {
      const cursor = Number(new URL(String(url)).searchParams.get('cursor'));
      return jsonResponse(pageFor(cursor));
    });
    vi.stubGlobal('fetch', fetchMock);

    const applied = await store.collection<Widget>('widgets').pullAll();
    expect(applied.map((w) => w.id)).toEqual(['w1', 'w2']);
    // One request per page; the loop stopped once hasMore was false.
    const pullCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/pull'));
    expect(pullCalls).toHaveLength(2);
    expect(String(pullCalls[0][0])).toContain('cursor=0');
    expect(String(pullCalls[1][0])).toContain('cursor=1');
  });
});

describe('Store pull-on-read', () => {
  it('fires a background pull on read, landing server changes', async () => {
    const { adapter, store } = setup({}, SYNC);
    await adapter.put('widgets', mkDoc('w1', 'old', '2026-01-01T00:00:00.000Z'));
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({
        documents: [
          {
            id: 'w1',
            collection: 'widgets',
            updatedAt: '2026-05-05T00:00:00.000Z',
            data: mkDoc('w1', 'new', '2026-05-05T00:00:00.000Z'),
          },
        ],
        cursor: 1,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    // The read resolves immediately against local state...
    expect((await store.collection<Widget>('widgets').list())[0].name).toBe('old');
    // ...while the background pull lands the newer server copy.
    await vi.waitFor(async () => {
      expect((await adapter.get<Widget>('widgets', 'w1'))?.name).toBe('new');
    });

    // A second read inside the throttle window must not pull again.
    await store.collection<Widget>('widgets').list();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/pull'))).toHaveLength(1);
  });

  it('does not pull on read without sync credentials', async () => {
    const { adapter, store } = setup({});
    await adapter.put('widgets', mkDoc('w1', 'x', '2026-01-01T00:00:00.000Z'));
    const fetchMock = vi.fn(async () => jsonResponse({ documents: [], cursor: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await store.collection<Widget>('widgets').list();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Store realtime enablement', () => {
  it('opens a realtime socket after registering on a fresh store', async () => {
    // Realtime is server-driven: registering on a fresh install (no client doc
    // yet) must open a socket as soon as the server advertises realtime via
    // /info, without waiting for an app restart.
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      url: string;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/register')) return jsonResponse({ clientId: 'cl-x', token: 'tok' });
        if (u.includes('/info')) return jsonResponse({ realtime: true });
        return jsonResponse({ documents: [], cursor: 0 });
      })
    );

    const store = await Store.create({ adapter: new InMemoryAdapter(),
      collections: [widgetsDef],
    });
    const res = await store.sync.register('https://sync.test', 'pw', 'my-app', 'My Device');
    expect(res.ok).toBe(true);

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    expect(FakeWebSocket.instances[0].url).toContain('wss://sync.test/realtime?token=tok');
  });
});

describe('Store registerClient (multi-tenant)', () => {
  it('sends appName to the server and persists it in the registration', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/register')) return jsonResponse({ clientId: 'cl-x', token: 'tok' });
      if (u.includes('/info')) return jsonResponse({ realtime: false });
      return jsonResponse({ documents: [], cursor: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = setup();
    const res = await store.sync.register('https://sync.test', 'pw', 'my-app', 'My Device');
    expect(res.ok).toBe(true);

    const registerCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/auth/register')
    );
    const body = JSON.parse(
      ((registerCall![1] as RequestInit | undefined)?.body ?? '{}') as string
    ) as Record<string, unknown>;
    expect(body.appName).toBe('my-app');

    const registration = await store.sync.registration();
    expect(registration).toMatchObject({ appName: 'my-app', url: 'https://sync.test' });
  });
});

describe('Store pushAll', () => {
  it('pushes every doc, including system-authored seeds', async () => {
    const { adapter, store } = setup({}, SYNC);
    await adapter.put('widgets', mkDoc('seed', 'S', '2026-01-01T00:00:00.000Z', SYSTEM_AUTHOR_ID));
    await adapter.put('widgets', mkDoc('real', 'R', '2026-01-01T00:00:00.000Z', 'us/1'));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ accepted: 2, skipped: 0 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await store.sync.push();

    const pushCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/sync/push'));
    expect(pushCall).toBeDefined();
    const body = JSON.parse((pushCall![1] as RequestInit).body as string) as {
      documents: { id: string }[];
    };
    expect(body.documents.map((d) => d.id).sort()).toEqual(['real', 'seed']);
  });
});

describe('Store.seed', () => {
  const seedSet = (version: string, name = 'Garlic'): SeedSet => ({
    version,
    docs: new Map([['widgets', [{ id: 'w-seed', name }]]]),
  });

  it('writes system-authored docs and records the version marker', async () => {
    const { store } = setup();
    const { written } = await store.seed(seedSet('v1'));
    expect(written).toBe(1);
    expect(await store.collection<Widget>('widgets').get('w-seed')).toMatchObject({
      name: 'Garlic',
      createdBy: SYSTEM_AUTHOR_ID,
      updatedBy: SYSTEM_AUTHOR_ID,
    });
  });

  it('is a no-op while the stored version matches', async () => {
    const { adapter, store } = setup();
    await store.seed(seedSet('v1'));
    const before = await adapter.get<Widget>('widgets', 'w-seed');
    expect((await store.seed(seedSet('v1', 'Changed'))).written).toBe(0);
    expect(await adapter.get<Widget>('widgets', 'w-seed')).toEqual(before);
  });

  it('applies a new version but skips docs whose content is unchanged', async () => {
    const { adapter, store } = setup();
    await store.seed(seedSet('v1'));
    const before = await adapter.get<Widget>('widgets', 'w-seed');
    const { written } = await store.seed(seedSet('v2'));
    expect(written).toBe(0);
    // No timestamp churn: the doc was not rewritten just to bump updatedAt.
    expect(await adapter.get<Widget>('widgets', 'w-seed')).toEqual(before);
    // ...but the marker advanced, so the next call is a single read again.
    expect((await store.seed(seedSet('v2'))).written).toBe(0);
  });

  it('updates untouched docs when their content changes', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    const { written } = await store.seed(seedSet('v2', 'Roasted garlic'));
    expect(written).toBe(1);
    expect((await store.collection<Widget>('widgets').get('w-seed'))?.name).toBe('Roasted garlic');
  });

  it('never clobbers user-edited docs', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').update('w-seed', { name: 'Mine' });
    await store.seed(seedSet('v2', 'Roasted garlic'));
    expect((await store.collection<Widget>('widgets').get('w-seed'))?.name).toBe('Mine');
  });

  it('fills undefined fields on user-edited docs without touching their values', async () => {
    type Enriched = Widget & { note?: string | null };
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').update('w-seed', { name: 'Mine' });

    const { written } = await store.seed({
      version: 'v2',
      docs: new Map([['widgets', [{ id: 'w-seed', name: 'Garlic', note: 'Allium' }]]]),
    });

    expect(written).toBe(1);
    const doc = await store.collection<Enriched>('widgets').get('w-seed');
    expect(doc?.name).toBe('Mine'); // user's value kept
    expect(doc?.note).toBe('Allium'); // previously-undefined field filled
    expect(doc?.updatedBy).toBe('us/1'); // still author-touched for future seeds
  });

  it('does not fill fields an author explicitly set to null', async () => {
    type Enriched = Widget & { note?: string | null };
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.author.set('us/1');
    await store.collection<Enriched>('widgets').update('w-seed', { note: null });

    await store.seed({
      version: 'v2',
      docs: new Map([['widgets', [{ id: 'w-seed', name: 'Garlic', note: 'Allium' }]]]),
    });

    expect((await store.collection<Enriched>('widgets').get('w-seed'))?.note).toBeNull();
  });

  it('never resurrects user-deleted docs', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.author.set('us/1');
    await store.collection('widgets').delete('w-seed');
    await store.seed(seedSet('v2'));
    expect(await store.collection<Widget>('widgets').get('w-seed')).toBeNull();
  });

  it('force re-applies even when the version matches', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.seed(seedSet('v1', 'Changed'), { force: true });
    expect((await store.collection<Widget>('widgets').get('w-seed'))?.name).toBe('Changed');
  });
});

describe('Store outbox (durable push retry)', () => {
  // A fetch mock whose push leg fails until `online` flips true; pull always
  // returns an empty page. Records each pushed batch body for assertions.
  function syncMock(state: { online: boolean }) {
    const pushedBatches: { documents: { data: Widget }[] }[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/sync/push')) {
        if (!state.online) throw new Error('offline');
        pushedBatches.push(JSON.parse((init!.body as string) ?? '{}'));
        return jsonResponse({ accepted: 1, skipped: 0 });
      }
      return jsonResponse({ documents: [], cursor: 0, hasMore: false });
    });
    return { fetchMock, pushedBatches };
  }

  it('keeps a write that failed to push and retries it on the next drain', async () => {
    const { store } = setup({}, SYNC);
    await store.author.set('us/1');
    const state = { online: false };
    const { fetchMock } = syncMock(state);
    vi.stubGlobal('fetch', fetchMock);

    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    // The local write survives and is queued even though the push failed.
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('Alpha');
    expect(await store.sync.pending()).toBe(1);

    // Back online: a drain flushes the queue and clears it.
    state.online = true;
    await store.sync.push();
    expect(await store.sync.pending()).toBe(0);
    const pushCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/push'));
    expect(pushCalls.length).toBeGreaterThanOrEqual(2); // initial failure + drain success
  });

  it('clears the queue immediately when the push succeeds online', async () => {
    const { store } = setup({}, SYNC);
    await store.author.set('us/1');
    const { fetchMock } = syncMock({ online: true });
    vi.stubGlobal('fetch', fetchMock);

    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    // The mutation's own drain is fire-and-forget; wait for it to settle.
    await vi.waitFor(async () => expect(await store.sync.pending()).toBe(0));
  });

  it('coalesces repeated edits of one doc into a single push of the latest version', async () => {
    const { store } = setup({}, SYNC);
    await store.author.set('us/1');
    const state = { online: false };
    const { fetchMock, pushedBatches } = syncMock(state);
    vi.stubGlobal('fetch', fetchMock);

    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'v1' });
    await store.collection<Widget>('widgets').update('w1', { name: 'v2' });
    // One entry for the doc, not one per edit.
    expect(await store.sync.pending()).toBe(1);

    state.online = true;
    await store.sync.push();
    expect(await store.sync.pending()).toBe(0);
    // The drained push carried the latest version.
    const lastBatch = pushedBatches[pushedBatches.length - 1];
    expect(lastBatch.documents[0].data.name).toBe('v2');
  });

  it('leaves writes queued until an identity is claimed', async () => {
    const { store } = setup({}, SYNC);
    // No setAuthor: still the local-author placeholder, which the server rejects.
    const { fetchMock } = syncMock({ online: true });
    vi.stubGlobal('fetch', fetchMock);

    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    await store.sync.push();
    // Drain is a no-op pre-claim; the write stays queued and no push is attempted.
    expect(await store.sync.pending()).toBe(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/push'))).toHaveLength(0);
  });

  it('does not queue anything without a sync client', async () => {
    const { store } = setup(); // no sync configured
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    expect(await store.sync.pending()).toBe(0);
  });
});

describe('Store resyncFromScratch', () => {
  // A registered _config/client doc: the credentials + identity that must
  // survive the reset (unlike wipe, the install stays registered).
  function clientDoc() {
    return {
      ...mkDoc('client', '', '2026-01-01T00:00:00.000Z'),
      clientId: 'cl-1',
      clientName: 'Dev',
      url: SYNC.syncUrl,
      token: SYNC.syncToken,
    };
  }

  it('drops all local synced data and re-pulls from a fresh cursor, keeping _config', async () => {
    const { adapter, store } = setup({}, SYNC);
    // Stale local world + sync bookkeeping that the reset must clear.
    await adapter.put('widgets', mkDoc('w1', 'stale', '2026-01-01T00:00:00.000Z'));
    await adapter.put('widgets', mkDoc('w2', 'gone-on-server', '2026-01-01T00:00:00.000Z'));
    await adapter.put('_sync_meta', {
      ...mkDoc('widgets', '', '2026-01-01T00:00:00.000Z'),
      cursor: 5,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    await adapter.put('_outbox', {
      ...mkDoc('widgets-w1', '', '2026-01-01T00:00:00.000Z'),
      collection: 'widgets',
      docId: 'w1',
    });
    await adapter.put('_config', clientDoc());

    const fetchMock = vi.fn(async (_url: unknown) =>
      jsonResponse({
        documents: [
          {
            id: 'w3',
            collection: 'widgets',
            updatedAt: '2026-05-05T00:00:00.000Z',
            data: mkDoc('w3', 'from-server', '2026-05-05T00:00:00.000Z'),
          },
        ],
        cursor: 1,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await store.sync.resync();

    // Local world is now exactly what the server returned — the stale local
    // docs are gone, not merged.
    expect((await adapter.getAll<Widget>('widgets')).map((w) => w.id)).toEqual(['w3']);
    // The cursor was reset: the re-pull started from 0, not the stale 5.
    const pullCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/pull'));
    expect(pullCalls).toHaveLength(1);
    expect(String(pullCalls[0][0])).toContain('cursor=0');
    // The outbox is dropped, not drained (its entries target old ids).
    expect(await adapter.getAll('_outbox')).toHaveLength(0);
    // _config survives, so the install stays registered + identified.
    expect(await adapter.get('_config', 'client')).toMatchObject({ clientId: 'cl-1' });
  });

  it('clears cursors even when the immediate re-pull fails, so a later sync backfills', async () => {
    const { adapter, store } = setup({}, SYNC);
    await adapter.put('widgets', mkDoc('w1', 'stale', '2026-01-01T00:00:00.000Z'));
    await adapter.put('_sync_meta', {
      ...mkDoc('widgets', '', '2026-01-01T00:00:00.000Z'),
      cursor: 5,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    await adapter.put('_config', clientDoc());

    // The immediate re-pull fails (offline): resyncFromScratch must still
    // resolve and leave the store in a re-pullable state.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await expect(store.sync.resync()).resolves.toBeUndefined();

    // Local data was dropped and the stale cursor cleared; _config kept.
    expect(await adapter.getAll('widgets')).toHaveLength(0);
    expect(await adapter.get('_sync_meta', 'widgets')).toBeNull();
    expect(await adapter.get('_config', 'client')).toMatchObject({ clientId: 'cl-1' });

    // The reset cursor means the next foreground sync re-pulls from 0 and
    // backfills the rewritten world — no data lost to the offline failure.
    const fetchMock = vi.fn(async (_url: unknown) =>
      jsonResponse({
        documents: [
          {
            id: 'w9',
            collection: 'widgets',
            updatedAt: '2026-05-05T00:00:00.000Z',
            data: mkDoc('w9', 'backfilled', '2026-05-05T00:00:00.000Z'),
          },
        ],
        cursor: 1,
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    await store.collection<Widget>('widgets').pullAll();
    expect((await store.collection<Widget>('widgets').get('w9'))?.name).toBe('backfilled');
    expect(String(fetchMock.mock.calls[0][0])).toContain('cursor=0');
  });
});

class InMemoryBlobAdapter implements BlobAdapter {
  private bytes = new Map<string, Uint8Array>();
  private mimes = new Map<string, string>();
  async has(hash: string) {
    return this.bytes.has(hash);
  }
  async read(hash: string) {
    return this.bytes.get(hash) ?? null;
  }
  async mimeType(hash: string) {
    return this.mimes.get(hash) ?? null;
  }
  async write(hash: string, bytes: Uint8Array, mimeType: string) {
    this.bytes.set(hash, bytes);
    this.mimes.set(hash, mimeType);
  }
  async delete(hash: string) {
    this.bytes.delete(hash);
    this.mimes.delete(hash);
  }
  async list() {
    return Array.from(this.bytes.keys());
  }
  uriFor(hash: string) {
    return this.bytes.has(hash) ? `mem://${hash}` : null;
  }
}

describe('Store backup/restore', () => {
  function setupWithBlobs(domain: Partial<StoreDomain> = {}) {
    const adapter = new InMemoryAdapter();
    const blobs = new InMemoryBlobAdapter();
    const store = new Store({ adapter, blobs, collections: [widgetsDef], ...domain });
    return { adapter, blobs, store };
  }

  it('round-trips documents and tombstones, excluding internal _* collections', async () => {
    const { adapter: srcAdapter, store: source } = setup();
    await source.author.set('us/1');
    await source.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    await source.collection<Widget>('widgets').create({ id: 'w2', name: 'Beta' });
    await source.collection('widgets').delete('w2'); // tombstone — must travel
    // Device-specific bookkeeping that must NOT end up in a portable backup.
    await srcAdapter.put('_config', { ...mkDoc('client', '', '2026-01-01T00:00:00.000Z') });
    await srcAdapter.put('_sync_meta', {
      ...mkDoc('widgets', '', '2026-01-01T00:00:00.000Z'),
      cursor: 7,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });

    const archive = await source.backup.create();

    const { adapter, store } = setup();
    const result = await store.backup.restore(archive);

    expect(result).toMatchObject({ mode: 'merge', collections: ['widgets'], docsWritten: 2 });
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('Alpha');
    expect(await store.collection<Widget>('widgets').get('w2')).toBeNull(); // hidden (deleted)...
    expect((await store.collection<Widget>('widgets').get('w2', { includeDeleted: true }))?.deletedAt).not.toBeNull();
    // Internal collections never crossed over.
    expect(await adapter.get('_config', 'client')).toBeNull();
    expect(await adapter.get('_sync_meta', 'widgets')).toBeNull();
  });

  it('merge keeps a newer local doc and overwrites an older one (last-write-wins)', async () => {
    // Build the backup directly via the adapter so the timestamps are explicit.
    const { adapter: sa, store: src } = setup();
    await sa.put('widgets', mkDoc('w1', 'backup-1', '2026-01-01T00:00:00.000Z'));
    await sa.put('widgets', mkDoc('w2', 'backup-2', '2026-06-01T00:00:00.000Z'));
    const archive = await src.backup.create({ blobs: false });

    const { adapter, store } = setup();
    await adapter.put('widgets', mkDoc('w1', 'local-1', '2026-03-01T00:00:00.000Z')); // newer
    await adapter.put('widgets', mkDoc('w2', 'local-2', '2026-01-01T00:00:00.000Z')); // older

    const result = await store.backup.restore(archive, { mode: 'merge' });

    expect(result).toMatchObject({ docsWritten: 1, docsSkipped: 1 });
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('local-1'); // kept
    expect((await store.collection<Widget>('widgets').get('w2'))?.name).toBe('backup-2'); // overwritten
  });

  it('replace clears the carried collections then loads the backup verbatim', async () => {
    const { adapter: sa, store: src } = setup();
    await sa.put('widgets', mkDoc('w1', 'backup-1', '2026-01-01T00:00:00.000Z'));
    const archive = await src.backup.create({ blobs: false });

    const { adapter, store } = setup();
    await adapter.put('widgets', mkDoc('w1', 'local-old', '2026-09-01T00:00:00.000Z'));
    await adapter.put('widgets', mkDoc('w2', 'local-extra', '2026-09-01T00:00:00.000Z'));

    const result = await store.backup.restore(archive, { mode: 'replace' });

    expect(result).toMatchObject({ mode: 'replace', docsWritten: 1, docsSkipped: 0 });
    // Even though local w1 was newer, replace ignores LWW and loads verbatim;
    // w2 (absent from the backup) is dropped.
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('backup-1');
    expect(await store.collection<Widget>('widgets').get('w2')).toBeNull();
  });

  it('round-trips blob bytes; merge skips a hash already present', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    const bytes = Uint8Array.from([1, 2, 3, 250, 0, 99]);
    await srcBlobs.write('hash-a', bytes, 'image/png');
    const archive = await source.backup.create();

    const { blobs, store } = setupWithBlobs();
    const result = await store.backup.restore(archive);
    expect(result.blobsWritten).toBe(1);
    expect(Array.from((await blobs.read('hash-a'))!)).toEqual(Array.from(bytes));
    expect(await blobs.mimeType('hash-a')).toBe('image/png');

    // Re-restoring is idempotent: the hash is content-addressed, so it's skipped.
    const again = await store.backup.restore(archive);
    expect(again.blobsWritten).toBe(0);
  });

  it('replace wipes local blobs before loading the backup set', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    await srcBlobs.write('hash-keep', Uint8Array.from([1]), 'image/png');
    const archive = await source.backup.create();

    const { blobs, store } = setupWithBlobs();
    await blobs.write('hash-stale', Uint8Array.from([9]), 'image/png');
    await store.backup.restore(archive, { mode: 'replace' });

    expect(await blobs.has('hash-stale')).toBe(false);
    expect(await blobs.has('hash-keep')).toBe(true);
  });

  it('reports blobs as skipped when the target store has no blob adapter', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    await srcBlobs.write('hash-a', Uint8Array.from([1, 2]), 'image/png');
    await source.author.set('us/1');
    await source.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    const archive = await source.backup.create();

    const { store } = setup(); // no blob adapter
    const result = await store.backup.restore(archive);

    expect(result).toMatchObject({ docsWritten: 1, blobsWritten: 0, blobsSkipped: 1 });
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('Alpha');
  });

  it('omits blobs from a documents-only archive', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    await srcBlobs.write('hash-a', Uint8Array.from([1]), 'image/png');
    const archive = await source.backup.create({ blobs: false });

    const { blobs, store } = setupWithBlobs();
    const result = await store.backup.restore(archive);
    expect(result.blobsWritten).toBe(0);
    expect(await blobs.has('hash-a')).toBe(false);
  });
});

describe('Store blob GC', () => {
  type Photo = BaseDocument & { imageHash?: string };
  const photosDef = defineCollection({
    name: 'photos',
    idPrefix: 'p',
    schema: (base) => base.extend({ id: z.string(), imageHash: z.string().optional() }),
  });
  const blobDomain: StoreDomain = {
    collections: [photosDef],
    blobHashes: blobFields({ photos: ['imageHash'] }),
  };

  function setupWithBlobs(domain: StoreDomain) {
    const adapter = new InMemoryAdapter();
    const blobs = new InMemoryBlobAdapter();
    const store = new Store({ adapter, blobs, ...domain });
    return { adapter, blobs, store };
  }

  it('collects only blobs no live document references', async () => {
    const { blobs, store } = setupWithBlobs(blobDomain);
    await store.author.set('us/1');
    await blobs.write('h-used', Uint8Array.from([1]), 'image/png');
    await blobs.write('h-orphan', Uint8Array.from([2]), 'image/png');
    await store.collection<Photo>('photos').create({ id: 'p1', imageHash: 'h-used' });

    const { deleted } = await store.blobs.prune();

    expect(deleted).toEqual(['h-orphan']);
    expect(await blobs.has('h-used')).toBe(true);
    expect(await blobs.has('h-orphan')).toBe(false);
  });

  it('treats a blob referenced only by a tombstone as collectable', async () => {
    const { blobs, store } = setupWithBlobs(blobDomain);
    await store.author.set('us/1');
    await blobs.write('h-x', Uint8Array.from([1]), 'image/png');
    await store.collection<Photo>('photos').create({ id: 'p1', imageHash: 'h-x' });
    await store.collection('photos').delete('p1'); // soft delete — doc stays as a tombstone

    const { deleted } = await store.blobs.prune();

    expect(deleted).toEqual(['h-x']);
    expect(await blobs.has('h-x')).toBe(false);
  });

  it('refuses to prune when the domain declares no blobHashes extractor', async () => {
    const { blobs, store } = setupWithBlobs({ collections: [photosDef] });
    await blobs.write('h-x', Uint8Array.from([1]), 'image/png');

    await expect(store.blobs.prune()).rejects.toThrow(/blobHashes extractor/);
    // The guard must not have deleted anything.
    expect(await blobs.has('h-x')).toBe(true);
  });

  it('referencedBlobHashes unions across live docs and skips not-yet-set fields', async () => {
    const { store } = setupWithBlobs(blobDomain);
    await store.author.set('us/1');
    await store.collection<Photo>('photos').create({ id: 'p1', imageHash: 'h-a' });
    await store.collection<Photo>('photos').create({ id: 'p2', imageHash: 'h-b' });
    await store.collection<Photo>('photos').create({ id: 'p3' }); // no hash field set

    const refs = await store.blobs.referencedHashes();

    expect(refs).toEqual(new Set(['h-a', 'h-b']));
  });

  it('pruneBlobs is a no-op without a blob adapter', async () => {
    const store = new Store({ adapter: new InMemoryAdapter(), ...blobDomain });
    await expect(store.blobs.prune()).resolves.toEqual({ deleted: [] });
  });
});

describe('Store encryption (optional E2E)', () => {
  const cipher = createWebCryptoCipher(new Uint8Array(32).fill(9));
  const otherCipher = createWebCryptoCipher(new Uint8Array(32).fill(10));

  function setupEncrypted(options?: StoreSyncConfig) {
    const inner = new InMemoryAdapter();
    const store = new Store({
      adapter: inner,
      collections: [widgetsDef],
      encryption: { cipher },
      sync: options,
    });
    return { inner, store };
  }

  it('round-trips through the Store while persisting only ciphertext', async () => {
    const { inner, store } = setupEncrypted();
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Secret Soup' });

    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('Secret Soup');
    expect((await store.collection<Widget>('widgets').list())[0]!.name).toBe('Secret Soup');

    const stored = await inner.get<BaseDocument>('widgets', 'w1');
    expect(isEncryptedDoc(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('Secret Soup');
  });

  it('sends ciphertext on the wire and decrypts pulled envelopes', async () => {
    const { store } = setupEncrypted(SYNC);
    await store.author.set('us/1');

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/sync/push')) return jsonResponse({ accepted: 1, skipped: 0 });
      return jsonResponse({ documents: [], cursor: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Secret Soup' });
    await store.sync.push();

    const pushCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/sync/push'))!;
    const body = JSON.parse((pushCall[1] as RequestInit).body as string) as {
      documents: { id: string; updatedAt: string; data: Record<string, unknown> }[];
    };
    expect(body.documents[0]!.id).toBe('w1');
    expect(isEncryptedDoc(body.documents[0]!.data)).toBe(true);
    expect((pushCall[1] as RequestInit).body as string).not.toContain('Secret Soup');

    // Pull: server returns an envelope; the store lands the decrypted doc.
    const remote = await encryptDoc(
      cipher,
      'widgets',
      mkDoc('w2', 'From Server', '2026-06-06T00:00:00.000Z')
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          documents: [
            { id: 'w2', collection: 'widgets', updatedAt: remote.updatedAt, data: remote },
          ],
          cursor: 1,
        })
      )
    );
    const applied = await store.collection<Widget>('widgets').pullAll();
    expect(applied).toHaveLength(1);
    expect((await store.collection<Widget>('widgets').get('w2'))?.name).toBe('From Server');
  });

  it('Store.create fails fast when the key does not match existing data', async () => {
    const inner = new InMemoryAdapter();
    const domain: StoreDomain = { collections: [widgetsDef], encryption: { cipher } };
    await Store.create({ adapter: inner, ...domain }); // writes the key check
    await expect(
      Store.create({ adapter: inner, collections: [widgetsDef], encryption: { cipher: otherCipher } })
    ).rejects.toThrow(/key does not match/);
    // The right key keeps opening fine.
    await expect(Store.create({ adapter: inner, ...domain })).resolves.toBeInstanceOf(Store);
  });

  it('encryptLocalData converts pre-existing plaintext rows', async () => {
    const inner = new InMemoryAdapter();
    await inner.put('widgets', mkDoc('legacy', 'Plain Old Doc', '2026-01-01T00:00:00.000Z'));
    const store = new Store({ adapter: inner, collections: [widgetsDef], encryption: { cipher } });

    // Readable before conversion (plaintext pass-through)…
    expect((await store.collection<Widget>('widgets').get('legacy'))?.name).toBe('Plain Old Doc');

    const { rewritten } = await store.encryption.encryptLocal();
    expect(rewritten).toBe(1);
    expect(isEncryptedDoc(await inner.get<BaseDocument>('widgets', 'legacy'))).toBe(true);
    expect((await store.collection<Widget>('widgets').get('legacy'))?.name).toBe('Plain Old Doc');
  });

  it('binds envelopes to the physical key when a collection is aliased', async () => {
    const aliasedWidgets = { ...widgetsDef, key: 'c1' };
    const inner = new InMemoryAdapter();
    const store = new Store({
      adapter: inner,
      collections: [aliasedWidgets],
      encryption: { cipher },
    });
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Secret Soup' });

    // Persisted under the key, sealed, and AAD-bound to `c1/w1` — opening it
    // as `widgets/w1` must fail (proves local and wire identities agree).
    const stored = (await inner.get<BaseDocument>('c1', 'w1'))!;
    expect(isEncryptedDoc(stored)).toBe(true);
    await expect(decryptDoc(cipher, 'c1', stored)).resolves.toMatchObject({ name: 'Secret Soup' });
    await expect(decryptDoc(cipher, 'widgets', stored)).rejects.toThrow();

    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('Secret Soup');
  });

  it('pushAll filters _local-authored docs (server can no longer see authors)', async () => {
    const { adapter, store } = setup({}, SYNC);
    await adapter.put('widgets', mkDoc('mine', 'ok', '2026-01-01T00:00:00.000Z', 'us/1'));
    await adapter.put('widgets', mkDoc('stray', 'no', '2026-01-01T00:00:00.000Z', LOCAL_AUTHOR_ID));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ accepted: 1, skipped: 0 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await store.sync.push();

    const pushCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/sync/push'))!;
    const body = JSON.parse((pushCall[1] as RequestInit).body as string) as {
      documents: { id: string }[];
    };
    expect(body.documents.map((d) => d.id)).toEqual(['mine']);
  });
});

describe('Store collection aliasing (name in code, key in storage/wire)', () => {
  const aliasedWidgets = { ...widgetsDef, key: 'c1' };

  function setupAliased(options?: StoreSyncConfig) {
    const inner = new InMemoryAdapter();
    const store = new Store({ adapter: inner, collections: [aliasedWidgets], sync: options });
    return { inner, store };
  }

  it('CRUD speaks the name while storage holds the key; events use the name', async () => {
    const { inner, store } = setupAliased();
    const onChange = vi.fn();
    store.on('change', onChange);
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });

    expect(await inner.get('c1', 'w1')).not.toBeNull();
    expect(await inner.get('widgets', 'w1')).toBeNull();
    expect((await store.collection<Widget>('widgets').get('w1'))?.name).toBe('Alpha');
    expect((await store.collection<Widget>('widgets').list()).map((w) => w.id)).toEqual(['w1']);
    expect(onChange).toHaveBeenCalledWith('widgets');
    expect(onChange).not.toHaveBeenCalledWith('c1');
  });

  it('pushes and pulls under the key on the wire', async () => {
    const { store } = setupAliased(SYNC);
    await store.author.set('us/1');
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/sync/push')) return jsonResponse({ accepted: 1, skipped: 0 });
      return jsonResponse({ documents: [], cursor: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    await store.sync.push();
    const pushCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/sync/push'))!;
    const body = JSON.parse((pushCall[1] as RequestInit).body as string) as {
      documents: { collection: string }[];
    };
    expect(body.documents[0]!.collection).toBe('c1');

    await store.collection('widgets').pullAll();
    const pullCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/sync/pull'))!;
    expect(String(pullCall[0])).toContain('collection=c1');
    expect(String(pullCall[0])).not.toContain('widgets');
  });

  it('translates realtime invalidations (keys) back to names', async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      url: string;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/info')) return jsonResponse({ realtime: true });
      return jsonResponse({ documents: [], cursor: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = setupAliased(SYNC);
    const onChange = vi.fn();
    store.on('change', onChange);
    await store.author.set('us/1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    // Server broadcasts the physical key; the pull path (cursor doc, change
    // event) must run under the code-facing name.
    fetchMock.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          documents: [
            {
              id: 'w9',
              collection: 'c1',
              updatedAt: '2026-06-06T00:00:00.000Z',
              data: mkDoc('w9', 'From Server', '2026-06-06T00:00:00.000Z'),
            },
          ],
          cursor: 1,
        })
      )
    );
    FakeWebSocket.instances[0]!.onmessage!({
      data: JSON.stringify({ type: 'invalidate', collections: ['c1'] }),
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('widgets'));
    expect((await store.collection<Widget>('widgets').get('w9'))?.name).toBe('From Server');
  });

  it('backups carry names, and restore lands docs back under the key', async () => {
    const { store } = setupAliased();
    await store.author.set('us/1');
    await store.collection<Widget>('widgets').create({ id: 'w1', name: 'Alpha' });
    const archive = await store.backup.create();

    // Restore into a store with a *different* key for the same collection:
    // the name is the portable identity, so the archive still applies.
    const inner2 = new InMemoryAdapter();
    const store2 = new Store({
      adapter: inner2,
      collections: [{ ...widgetsDef, key: 'k2' }],
    });
    const result = await store2.backup.restore(archive);
    expect(result.docsWritten).toBe(1);
    expect(result.collections).toEqual(['widgets']);
    expect(await inner2.get('k2', 'w1')).not.toBeNull();
    expect((await store2.collection<Widget>('widgets').get('w1'))?.name).toBe('Alpha');
  });
});
