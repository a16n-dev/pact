import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store, type SeedSet, type StoreDomain } from './store';
import type { StoreSyncConfig } from './store/types';
import { InMemoryAdapter } from './adapters/memoryAdapter';
import { defineCollection } from './collection';
import { LOCAL_AUTHOR_ID, SYSTEM_AUTHOR_ID } from './system';
import type { BaseDocument } from './types';
import type { BlobAdapter } from './blobs/blobAdapter';
import { blobFields } from './blobs/blobFields';
import { createWebCryptoCipher } from './crypto/webCrypto';
import { encryptDoc, isEncryptedDoc } from './crypto/docCrypto';

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
  const store = new Store(adapter, null, { collections: [widgetsDef], ...domain }, options);
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
    await store.setAuthor('us/1');
    const w = await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    expect(w).toMatchObject({
      id: 'w1',
      name: 'Alpha',
      createdBy: 'us/1',
      updatedBy: 'us/1',
      deletedAt: null,
    });
    expect(await store.get<Widget>('widgets', 'w1')).toMatchObject({ id: 'w1', name: 'Alpha' });
    expect(onChange).toHaveBeenCalledWith('widgets');
  });

  it('update preserves createdAt/createdBy and bumps the editor', async () => {
    const { store } = setup();
    await store.setAuthor('us/1');
    const created = await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    await store.setAuthor('us/2');
    const updated = await store.update<Widget>('widgets', 'w1', { name: 'Beta' });
    expect(updated.name).toBe('Beta');
    expect(updated.createdBy).toBe('us/1');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedBy).toBe('us/2');
  });

  it('delete soft-deletes; get/list hide it but getIncludingDeleted returns it', async () => {
    const { store } = setup();
    await store.setAuthor('us/1');
    await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    await store.create<Widget>('widgets', 'w2', { name: 'Beta' });
    await store.delete('widgets', 'w2');

    expect(await store.get<Widget>('widgets', 'w2')).toBeNull();
    expect((await store.list<Widget>('widgets')).map((w) => w.id)).toEqual(['w1']);
    expect((await store.getMany<Widget>('widgets', ['w1', 'w2'])).map((w) => w.id)).toEqual(['w1']);

    const tomb = await store.getIncludingDeleted<Widget>('widgets', 'w2');
    expect(tomb?.deletedAt).not.toBeNull();
    expect(tomb?.deletedBy).toBe('us/1');
  });
});

describe('Store collection registry (schemas define collections)', () => {
  it('rejects reads and writes against collections with no definition', async () => {
    const { store } = setup();
    await store.setAuthor('us/1');
    await expect(store.create<Widget>('gadgets', 'g1', { name: 'X' })).rejects.toThrow(
      /Unknown collection/
    );
    await expect(store.list('gadgets')).rejects.toThrow(/Unknown collection/);
    await expect(store.get('gadgets', 'g1')).rejects.toThrow(/Unknown collection/);
    await expect(store.delete('gadgets', 'g1')).rejects.toThrow(/Unknown collection/);
    expect(() => store.pull('gadgets')).toThrow(/Unknown collection/);
    expect(() => store.collection('gadgets' as never)).toThrow(/Unknown collection/);
  });

  it('validates writes against the collection schema', async () => {
    const { store } = setup();
    await store.setAuthor('us/1');
    await expect(
      store.create<Widget>('widgets', 'w1', { name: 42 } as unknown as { name: string })
    ).rejects.toThrow();
  });

  it('still allows internal _* bookkeeping collections without definitions', async () => {
    const { adapter, store } = setup();
    await store.setAuthor('us/1'); // writes _config/author
    expect(await adapter.get('_config', 'author')).toMatchObject({ authorId: 'us/1' });
  });

  it('rejects reserved and duplicate collection names at construction', () => {
    const internal = defineCollection({ name: '_secret', idPrefix: 'x', schema: (b) => b });
    expect(() => new Store(new InMemoryAdapter(), null, { collections: [internal] })).toThrow(
      /reserved/
    );
    const dupe = defineCollection({ name: 'widgets', idPrefix: 'q', schema: (b) => b });
    expect(
      () => new Store(new InMemoryAdapter(), null, { collections: [widgetsDef, dupe] })
    ).toThrow(/Duplicate/);
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

    const got = await store.get<Widget>('widgets', 'w1');
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
    await store.setAuthor('us/1');

    expect(await store.getCurrentAuthor()).toBe('us/1');
    expect(hook).toHaveBeenCalledWith(store, 'us/1');
    expect(await adapter.get('_config', 'author')).toMatchObject({ authorId: 'us/1' });
  });

  it('setAuthor rejects the system and local sentinel ids', async () => {
    const { store } = setup();
    await expect(store.setAuthor(SYSTEM_AUTHOR_ID)).rejects.toThrow();
    await expect(store.setAuthor(LOCAL_AUTHOR_ID)).rejects.toThrow();
  });

  it('reassignLocalAuthor moves local-authored docs (incl. tombstone deletedBy) to a real id', async () => {
    const { adapter, store } = setup();
    const w = await store.create<Widget>('widgets', 'w1', { name: 'X' });
    expect(w.createdBy).toBe(LOCAL_AUTHOR_ID);
    await store.create<Widget>('widgets', 'w2', { name: 'Y' });
    await store.delete('widgets', 'w2'); // soft-deleted while local: deletedBy === _local

    await store.reassignLocalAuthor('us/9');

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

    const applied = await store.pull<Widget>('widgets');
    expect(applied).toHaveLength(1);
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('new');
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

    const applied = await store.pull<Widget>('widgets');
    expect(applied).toHaveLength(0);
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('local-new');
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

    const applied = await store.pull<Widget>('widgets');
    expect(applied).toHaveLength(1);
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('server');
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

    const applied = await store.pull<Widget>('widgets');
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
    expect((await store.list<Widget>('widgets'))[0].name).toBe('old');
    // ...while the background pull lands the newer server copy.
    await vi.waitFor(async () => {
      expect((await adapter.get<Widget>('widgets', 'w1'))?.name).toBe('new');
    });

    // A second read inside the throttle window must not pull again.
    await store.list<Widget>('widgets');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/pull'))).toHaveLength(1);
  });

  it('does not pull on read without sync credentials', async () => {
    const { adapter, store } = setup({});
    await adapter.put('widgets', mkDoc('w1', 'x', '2026-01-01T00:00:00.000Z'));
    const fetchMock = vi.fn(async () => jsonResponse({ documents: [], cursor: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await store.list<Widget>('widgets');
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

    const store = await Store.create(new InMemoryAdapter(), null, {
      collections: [widgetsDef],
    });
    const res = await store.registerClient('https://sync.test', 'pw', 'my-app', 'My Device');
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
    const res = await store.registerClient('https://sync.test', 'pw', 'my-app', 'My Device');
    expect(res.ok).toBe(true);

    const registerCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/auth/register')
    );
    const body = JSON.parse(
      ((registerCall![1] as RequestInit | undefined)?.body ?? '{}') as string
    ) as Record<string, unknown>;
    expect(body.appName).toBe('my-app');

    const registration = await store.getClientRegistration();
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

    await store.pushAll();

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
    expect(await store.get<Widget>('widgets', 'w-seed')).toMatchObject({
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
    expect((await store.get<Widget>('widgets', 'w-seed'))?.name).toBe('Roasted garlic');
  });

  it('never clobbers user-edited docs', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.setAuthor('us/1');
    await store.update<Widget>('widgets', 'w-seed', { name: 'Mine' });
    await store.seed(seedSet('v2', 'Roasted garlic'));
    expect((await store.get<Widget>('widgets', 'w-seed'))?.name).toBe('Mine');
  });

  it('fills undefined fields on user-edited docs without touching their values', async () => {
    type Enriched = Widget & { note?: string | null };
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.setAuthor('us/1');
    await store.update<Widget>('widgets', 'w-seed', { name: 'Mine' });

    const { written } = await store.seed({
      version: 'v2',
      docs: new Map([['widgets', [{ id: 'w-seed', name: 'Garlic', note: 'Allium' }]]]),
    });

    expect(written).toBe(1);
    const doc = await store.get<Enriched>('widgets', 'w-seed');
    expect(doc?.name).toBe('Mine'); // user's value kept
    expect(doc?.note).toBe('Allium'); // previously-undefined field filled
    expect(doc?.updatedBy).toBe('us/1'); // still author-touched for future seeds
  });

  it('does not fill fields an author explicitly set to null', async () => {
    type Enriched = Widget & { note?: string | null };
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.setAuthor('us/1');
    await store.update<Enriched>('widgets', 'w-seed', { note: null });

    await store.seed({
      version: 'v2',
      docs: new Map([['widgets', [{ id: 'w-seed', name: 'Garlic', note: 'Allium' }]]]),
    });

    expect((await store.get<Enriched>('widgets', 'w-seed'))?.note).toBeNull();
  });

  it('never resurrects user-deleted docs', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.setAuthor('us/1');
    await store.delete('widgets', 'w-seed');
    await store.seed(seedSet('v2'));
    expect(await store.get<Widget>('widgets', 'w-seed')).toBeNull();
  });

  it('force re-applies even when the version matches', async () => {
    const { store } = setup();
    await store.seed(seedSet('v1'));
    await store.seed(seedSet('v1', 'Changed'), { force: true });
    expect((await store.get<Widget>('widgets', 'w-seed'))?.name).toBe('Changed');
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
    await store.setAuthor('us/1');
    const state = { online: false };
    const { fetchMock } = syncMock(state);
    vi.stubGlobal('fetch', fetchMock);

    await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    // The local write survives and is queued even though the push failed.
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('Alpha');
    expect(await store.pendingPushCount()).toBe(1);

    // Back online: a drain flushes the queue and clears it.
    state.online = true;
    await store.drainOutbox();
    expect(await store.pendingPushCount()).toBe(0);
    const pushCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/push'));
    expect(pushCalls.length).toBeGreaterThanOrEqual(2); // initial failure + drain success
  });

  it('clears the queue immediately when the push succeeds online', async () => {
    const { store } = setup({}, SYNC);
    await store.setAuthor('us/1');
    const { fetchMock } = syncMock({ online: true });
    vi.stubGlobal('fetch', fetchMock);

    await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    // The mutation's own drain is fire-and-forget; wait for it to settle.
    await vi.waitFor(async () => expect(await store.pendingPushCount()).toBe(0));
  });

  it('coalesces repeated edits of one doc into a single push of the latest version', async () => {
    const { store } = setup({}, SYNC);
    await store.setAuthor('us/1');
    const state = { online: false };
    const { fetchMock, pushedBatches } = syncMock(state);
    vi.stubGlobal('fetch', fetchMock);

    await store.create<Widget>('widgets', 'w1', { name: 'v1' });
    await store.update<Widget>('widgets', 'w1', { name: 'v2' });
    // One entry for the doc, not one per edit.
    expect(await store.pendingPushCount()).toBe(1);

    state.online = true;
    await store.drainOutbox();
    expect(await store.pendingPushCount()).toBe(0);
    // The drained push carried the latest version.
    const lastBatch = pushedBatches[pushedBatches.length - 1];
    expect(lastBatch.documents[0].data.name).toBe('v2');
  });

  it('leaves writes queued until an identity is claimed', async () => {
    const { store } = setup({}, SYNC);
    // No setAuthor: still the local-author placeholder, which the server rejects.
    const { fetchMock } = syncMock({ online: true });
    vi.stubGlobal('fetch', fetchMock);

    await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    await store.drainOutbox();
    // Drain is a no-op pre-claim; the write stays queued and no push is attempted.
    expect(await store.pendingPushCount()).toBe(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/sync/push'))).toHaveLength(0);
  });

  it('does not queue anything without a sync client', async () => {
    const { store } = setup(); // no sync configured
    await store.setAuthor('us/1');
    await store.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    expect(await store.pendingPushCount()).toBe(0);
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

    await store.resyncFromScratch();

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
    await expect(store.resyncFromScratch()).resolves.toBeUndefined();

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
    await store.pull<Widget>('widgets');
    expect((await store.get<Widget>('widgets', 'w9'))?.name).toBe('backfilled');
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
    const store = new Store(adapter, blobs, { collections: [widgetsDef], ...domain });
    return { adapter, blobs, store };
  }

  it('round-trips documents and tombstones, excluding internal _* collections', async () => {
    const { adapter: srcAdapter, store: source } = setup();
    await source.setAuthor('us/1');
    await source.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    await source.create<Widget>('widgets', 'w2', { name: 'Beta' });
    await source.delete('widgets', 'w2'); // tombstone — must travel
    // Device-specific bookkeeping that must NOT end up in a portable backup.
    await srcAdapter.put('_config', { ...mkDoc('client', '', '2026-01-01T00:00:00.000Z') });
    await srcAdapter.put('_sync_meta', {
      ...mkDoc('widgets', '', '2026-01-01T00:00:00.000Z'),
      cursor: 7,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });

    const archive = await source.createBackup();

    const { adapter, store } = setup();
    const result = await store.restoreBackup(archive);

    expect(result).toMatchObject({ mode: 'merge', collections: ['widgets'], docsWritten: 2 });
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('Alpha');
    expect(await store.get<Widget>('widgets', 'w2')).toBeNull(); // hidden (deleted)...
    expect((await store.getIncludingDeleted<Widget>('widgets', 'w2'))?.deletedAt).not.toBeNull();
    // Internal collections never crossed over.
    expect(await adapter.get('_config', 'client')).toBeNull();
    expect(await adapter.get('_sync_meta', 'widgets')).toBeNull();
  });

  it('merge keeps a newer local doc and overwrites an older one (last-write-wins)', async () => {
    // Build the backup directly via the adapter so the timestamps are explicit.
    const { adapter: sa, store: src } = setup();
    await sa.put('widgets', mkDoc('w1', 'backup-1', '2026-01-01T00:00:00.000Z'));
    await sa.put('widgets', mkDoc('w2', 'backup-2', '2026-06-01T00:00:00.000Z'));
    const archive = await src.createBackup({ blobs: false });

    const { adapter, store } = setup();
    await adapter.put('widgets', mkDoc('w1', 'local-1', '2026-03-01T00:00:00.000Z')); // newer
    await adapter.put('widgets', mkDoc('w2', 'local-2', '2026-01-01T00:00:00.000Z')); // older

    const result = await store.restoreBackup(archive, { mode: 'merge' });

    expect(result).toMatchObject({ docsWritten: 1, docsSkipped: 1 });
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('local-1'); // kept
    expect((await store.get<Widget>('widgets', 'w2'))?.name).toBe('backup-2'); // overwritten
  });

  it('replace clears the carried collections then loads the backup verbatim', async () => {
    const { adapter: sa, store: src } = setup();
    await sa.put('widgets', mkDoc('w1', 'backup-1', '2026-01-01T00:00:00.000Z'));
    const archive = await src.createBackup({ blobs: false });

    const { adapter, store } = setup();
    await adapter.put('widgets', mkDoc('w1', 'local-old', '2026-09-01T00:00:00.000Z'));
    await adapter.put('widgets', mkDoc('w2', 'local-extra', '2026-09-01T00:00:00.000Z'));

    const result = await store.restoreBackup(archive, { mode: 'replace' });

    expect(result).toMatchObject({ mode: 'replace', docsWritten: 1, docsSkipped: 0 });
    // Even though local w1 was newer, replace ignores LWW and loads verbatim;
    // w2 (absent from the backup) is dropped.
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('backup-1');
    expect(await store.get<Widget>('widgets', 'w2')).toBeNull();
  });

  it('round-trips blob bytes; merge skips a hash already present', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    const bytes = Uint8Array.from([1, 2, 3, 250, 0, 99]);
    await srcBlobs.write('hash-a', bytes, 'image/png');
    const archive = await source.createBackup();

    const { blobs, store } = setupWithBlobs();
    const result = await store.restoreBackup(archive);
    expect(result.blobsWritten).toBe(1);
    expect(Array.from((await blobs.read('hash-a'))!)).toEqual(Array.from(bytes));
    expect(await blobs.mimeType('hash-a')).toBe('image/png');

    // Re-restoring is idempotent: the hash is content-addressed, so it's skipped.
    const again = await store.restoreBackup(archive);
    expect(again.blobsWritten).toBe(0);
  });

  it('replace wipes local blobs before loading the backup set', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    await srcBlobs.write('hash-keep', Uint8Array.from([1]), 'image/png');
    const archive = await source.createBackup();

    const { blobs, store } = setupWithBlobs();
    await blobs.write('hash-stale', Uint8Array.from([9]), 'image/png');
    await store.restoreBackup(archive, { mode: 'replace' });

    expect(await blobs.has('hash-stale')).toBe(false);
    expect(await blobs.has('hash-keep')).toBe(true);
  });

  it('reports blobs as skipped when the target store has no blob adapter', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    await srcBlobs.write('hash-a', Uint8Array.from([1, 2]), 'image/png');
    await source.setAuthor('us/1');
    await source.create<Widget>('widgets', 'w1', { name: 'Alpha' });
    const archive = await source.createBackup();

    const { store } = setup(); // no blob adapter
    const result = await store.restoreBackup(archive);

    expect(result).toMatchObject({ docsWritten: 1, blobsWritten: 0, blobsSkipped: 1 });
    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('Alpha');
  });

  it('omits blobs from a documents-only archive', async () => {
    const { blobs: srcBlobs, store: source } = setupWithBlobs();
    await srcBlobs.write('hash-a', Uint8Array.from([1]), 'image/png');
    const archive = await source.createBackup({ blobs: false });

    const { blobs, store } = setupWithBlobs();
    const result = await store.restoreBackup(archive);
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
    const store = new Store(adapter, blobs, domain);
    return { adapter, blobs, store };
  }

  it('collects only blobs no live document references', async () => {
    const { blobs, store } = setupWithBlobs(blobDomain);
    await store.setAuthor('us/1');
    await blobs.write('h-used', Uint8Array.from([1]), 'image/png');
    await blobs.write('h-orphan', Uint8Array.from([2]), 'image/png');
    await store.create<Photo>('photos', 'p1', { imageHash: 'h-used' });

    const { deleted } = await store.pruneBlobs();

    expect(deleted).toEqual(['h-orphan']);
    expect(await blobs.has('h-used')).toBe(true);
    expect(await blobs.has('h-orphan')).toBe(false);
  });

  it('treats a blob referenced only by a tombstone as collectable', async () => {
    const { blobs, store } = setupWithBlobs(blobDomain);
    await store.setAuthor('us/1');
    await blobs.write('h-x', Uint8Array.from([1]), 'image/png');
    await store.create<Photo>('photos', 'p1', { imageHash: 'h-x' });
    await store.delete('photos', 'p1'); // soft delete — doc stays as a tombstone

    const { deleted } = await store.pruneBlobs();

    expect(deleted).toEqual(['h-x']);
    expect(await blobs.has('h-x')).toBe(false);
  });

  it('refuses to prune when the domain declares no blobHashes extractor', async () => {
    const { blobs, store } = setupWithBlobs({ collections: [photosDef] });
    await blobs.write('h-x', Uint8Array.from([1]), 'image/png');

    await expect(store.pruneBlobs()).rejects.toThrow(/blobHashes extractor/);
    // The guard must not have deleted anything.
    expect(await blobs.has('h-x')).toBe(true);
  });

  it('referencedBlobHashes unions across live docs and skips not-yet-set fields', async () => {
    const { store } = setupWithBlobs(blobDomain);
    await store.setAuthor('us/1');
    await store.create<Photo>('photos', 'p1', { imageHash: 'h-a' });
    await store.create<Photo>('photos', 'p2', { imageHash: 'h-b' });
    await store.create<Photo>('photos', 'p3', {}); // no hash field set

    const refs = await store.referencedBlobHashes();

    expect(refs).toEqual(new Set(['h-a', 'h-b']));
  });

  it('pruneBlobs is a no-op without a blob adapter', async () => {
    const store = new Store(new InMemoryAdapter(), null, blobDomain);
    await expect(store.pruneBlobs()).resolves.toEqual({ deleted: [] });
  });
});

describe('Store encryption (optional E2E)', () => {
  const cipher = createWebCryptoCipher(new Uint8Array(32).fill(9));
  const otherCipher = createWebCryptoCipher(new Uint8Array(32).fill(10));

  function setupEncrypted(options?: StoreSyncConfig) {
    const inner = new InMemoryAdapter();
    const store = new Store(
      inner,
      null,
      { collections: [widgetsDef], encryption: { cipher } },
      options
    );
    return { inner, store };
  }

  it('round-trips through the Store while persisting only ciphertext', async () => {
    const { inner, store } = setupEncrypted();
    await store.setAuthor('us/1');
    await store.create<Widget>('widgets', 'w1', { name: 'Secret Soup' });

    expect((await store.get<Widget>('widgets', 'w1'))?.name).toBe('Secret Soup');
    expect((await store.list<Widget>('widgets'))[0]!.name).toBe('Secret Soup');

    const stored = await inner.get<BaseDocument>('widgets', 'w1');
    expect(isEncryptedDoc(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('Secret Soup');
  });

  it('sends ciphertext on the wire and decrypts pulled envelopes', async () => {
    const { store } = setupEncrypted(SYNC);
    await store.setAuthor('us/1');

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/sync/push')) return jsonResponse({ accepted: 1, skipped: 0 });
      return jsonResponse({ documents: [], cursor: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await store.create<Widget>('widgets', 'w1', { name: 'Secret Soup' });
    await store.drainOutbox();

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
    const applied = await store.pull<Widget>('widgets');
    expect(applied).toHaveLength(1);
    expect((await store.get<Widget>('widgets', 'w2'))?.name).toBe('From Server');
  });

  it('Store.create fails fast when the key does not match existing data', async () => {
    const inner = new InMemoryAdapter();
    const domain: StoreDomain = { collections: [widgetsDef], encryption: { cipher } };
    await Store.create(inner, null, domain); // writes the key check
    await expect(
      Store.create(inner, null, { collections: [widgetsDef], encryption: { cipher: otherCipher } })
    ).rejects.toThrow(/key does not match/);
    // The right key keeps opening fine.
    await expect(Store.create(inner, null, domain)).resolves.toBeInstanceOf(Store);
  });

  it('encryptLocalData converts pre-existing plaintext rows', async () => {
    const inner = new InMemoryAdapter();
    await inner.put('widgets', mkDoc('legacy', 'Plain Old Doc', '2026-01-01T00:00:00.000Z'));
    const store = new Store(inner, null, { collections: [widgetsDef], encryption: { cipher } });

    // Readable before conversion (plaintext pass-through)…
    expect((await store.get<Widget>('widgets', 'legacy'))?.name).toBe('Plain Old Doc');

    const { rewritten } = await store.encryptLocalData();
    expect(rewritten).toBe(1);
    expect(isEncryptedDoc(await inner.get<BaseDocument>('widgets', 'legacy'))).toBe(true);
    expect((await store.get<Widget>('widgets', 'legacy'))?.name).toBe('Plain Old Doc');
  });

  it('pushAll filters _local-authored docs (server can no longer see authors)', async () => {
    const { adapter, store } = setup({}, SYNC);
    await adapter.put('widgets', mkDoc('mine', 'ok', '2026-01-01T00:00:00.000Z', 'us/1'));
    await adapter.put('widgets', mkDoc('stray', 'no', '2026-01-01T00:00:00.000Z', LOCAL_AUTHOR_ID));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ accepted: 1, skipped: 0 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await store.pushAll();

    const pushCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/sync/push'))!;
    const body = JSON.parse((pushCall[1] as RequestInit).body as string) as {
      documents: { id: string }[];
    };
    expect(body.documents.map((d) => d.id)).toEqual(['mine']);
  });
});
