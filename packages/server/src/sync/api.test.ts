import { describe, it, expect, vi } from 'vitest';
import { pushDocuments } from './api';
import { getDocumentsSince, upsertDocuments } from './db';
import type { Env, SyncDocument } from '../types';

function doc(id: string, collection: string, updatedAt: string, by = 'us/1'): SyncDocument {
  return {
    id,
    collection,
    updatedAt,
    data: { id, updatedAt, createdBy: by, updatedBy: by },
  };
}

/** Env whose DB throws if touched — proves a code path short-circuits before SQL. */
function throwingEnv(): Env {
  return {
    DB: {
      prepare() {
        throw new Error('DB should not be touched');
      },
      batch() {
        throw new Error('DB should not be touched');
      },
    },
    ENABLE_REALTIME: 'false',
  } as unknown as Env;
}

/** Env with a fake DB whose batch reports `changes` per statement. */
function fakeEnv(
  opts: { changes?: number[]; enableRealtime?: boolean; broadcast?: () => void } = {}
): Env {
  return {
    DB: {
      prepare: () => ({ bind: () => ({}) }),
      batch: async (stmts: unknown[]) =>
        stmts.map((_s, i) => ({ meta: { changes: opts.changes ? (opts.changes[i] ?? 0) : 1 } })),
    },
    BLOBS: {},
    API_KEY: 'k',
    SERVER_NAME: 'test',
    ENABLE_REALTIME: opts.enableRealtime ? 'true' : 'false',
    REALTIME: {
      idFromName: () => 'singleton',
      get: () => ({ broadcast: opts.broadcast ?? (() => {}) }),
    },
  } as unknown as Env;
}

describe('pushDocuments', () => {
  it('rejects a non-array body', async () => {
    const out = await pushDocuments(throwingEnv(), undefined as unknown as SyncDocument[]);
    expect(out).toMatchObject({ ok: false, code: 'bad_request', status: 400 });
  });

  it('rejects the whole batch (without touching the DB) if any doc is local-authored', async () => {
    const out = await pushDocuments(throwingEnv(), [
      doc('w1', 'widgets', 't'),
      {
        id: 'w2',
        collection: 'widgets',
        updatedAt: 't',
        data: { createdBy: '_local', updatedBy: 'us/1' },
      },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('local_author_push_rejected');
    expect(out.error).toContain('widgets/w2');
  });

  it('rejects a tombstone whose deletedBy is local-authored', async () => {
    const out = await pushDocuments(throwingEnv(), [
      {
        id: 'w1',
        collection: 'widgets',
        updatedAt: 't',
        data: { createdBy: 'us/1', updatedBy: 'us/1', deletedBy: '_local' },
      },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('local_author_push_rejected');
  });

  it('runs the migrate hook on each doc', async () => {
    const migrate = vi.fn((_collection: string, data: unknown) => data);
    await pushDocuments(fakeEnv(), [doc('w1', 'widgets', 't')], { hooks: { migrate } });
    expect(migrate).toHaveBeenCalledWith('widgets', expect.objectContaining({ id: 'w1' }));
  });

  it('fails with migration_failed when the migrate hook throws', async () => {
    const migrate = () => {
      throw new Error('schema too new');
    };
    const out = await pushDocuments(throwingEnv(), [doc('w1', 'widgets', 't')], {
      hooks: { migrate },
    });
    expect(out).toMatchObject({ ok: false, code: 'migration_failed', error: 'schema too new' });
  });

  it('returns accepted/skipped from the upsert', async () => {
    const out = await pushDocuments(fakeEnv({ changes: [1, 0] }), [
      doc('a', 'widgets', 't'),
      doc('b', 'widgets', 't'),
    ]);
    expect(out).toEqual({ ok: true, result: { accepted: 1, skipped: 1 } });
  });

  it('broadcasts to realtime when enabled and waitUntil is provided', async () => {
    const broadcast = vi.fn();
    const waitUntil = vi.fn();
    await pushDocuments(
      fakeEnv({ enableRealtime: true, broadcast, changes: [1] }),
      [doc('w1', 'widgets', 't')],
      {
        waitUntil,
      }
    );
    expect(broadcast).toHaveBeenCalledWith(['widgets']);
    expect(waitUntil).toHaveBeenCalled();
  });

  it('does not broadcast when realtime is disabled', async () => {
    const broadcast = vi.fn();
    await pushDocuments(
      fakeEnv({ enableRealtime: false, broadcast, changes: [1] }),
      [doc('w1', 'widgets', 't')],
      {
        waitUntil: vi.fn(),
      }
    );
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('upsertDocuments', () => {
  it('counts applied rows as accepted and the rest as skipped', async () => {
    const db = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => [{ meta: { changes: 1 } }, { meta: { changes: 0 } }],
    } as unknown as D1Database;
    const result = await upsertDocuments(db, [doc('a', 'c', 't'), doc('b', 'c', 't')]);
    expect(result).toEqual({ accepted: 1, skipped: 1 });
  });
});

describe('getDocumentsSince (pagination)', () => {
  // Fake D1 that returns `available` synthetic rows capped at the bound limit,
  // and records the limit it was asked for (the peek-ahead is limit+1).
  function pagingDb(available: number): { db: D1Database; boundLimit: () => number } {
    let asked = 0;
    const db = {
      prepare: () => ({
        bind: (_collection: string, cursor: number, limit: number) => {
          asked = limit;
          const n = Math.min(available, limit);
          const results = Array.from({ length: n }, (_v, i) => ({
            id: `d${i}`,
            collection: 'c',
            updated_at: 't',
            data: '{}',
            seq: cursor + i + 1,
          }));
          return { all: async () => ({ results }) };
        },
      }),
    } as unknown as D1Database;
    return { db, boundLimit: () => asked };
  }

  it('peeks one past the page and reports hasMore when the page is full', async () => {
    const { db, boundLimit } = pagingDb(10);
    const page = await getDocumentsSince(db, 'c', 0, 3);
    expect(boundLimit()).toBe(4); // limit + 1
    expect(page.documents).toHaveLength(3); // the extra peeked row is dropped
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(3); // max seq of the kept page
  });

  it('reports no more pages and the advanced cursor on the final partial page', async () => {
    const { db } = pagingDb(2);
    const page = await getDocumentsSince(db, 'c', 5, 3);
    expect(page.documents).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(7); // 5 + 2
  });

  it('leaves the cursor unchanged when nothing matches', async () => {
    const { db } = pagingDb(0);
    const page = await getDocumentsSince(db, 'c', 42, 3);
    expect(page.documents).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(42);
  });
});
