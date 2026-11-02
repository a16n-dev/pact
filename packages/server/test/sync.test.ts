import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { api, doc, push, seedApp } from './helpers';
import { sha256Hex } from '../src/lib/crypto';

async function pull(token: string, query: string) {
  const res = await api(`/sync/pull?${query}`, token);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    documents: {
      collection: string;
      id: string;
      writer_id: string;
      hlc: string;
      seq: number;
      data: string;
    }[];
    cursor: number;
    hasMore: boolean;
  };
}

describe('documents', () => {
  let a: Awaited<ReturnType<typeof seedApp>>;
  let b: Awaited<ReturnType<typeof seedApp>>;
  beforeEach(async () => {
    a = await seedApp('app-a');
    b = await seedApp('app-b');
  });

  it('rejects requests without a valid token', async () => {
    expect((await api('/sync/pull?cursor=0', null)).status).toBe(401);
    expect((await api('/sync/pull?cursor=0', 'pact_nope')).status).toBe(401);
    expect((await api('/auth/check', null)).status).toBe(401);
  });

  it('assigns increasing seqs from the app counter and returns the highest', async () => {
    const res = await push(a.token, [doc('n1', '{"a":1}'), doc('n2', '{"a":2}')]);
    expect(res.status).toBe(200);
    const { seq } = (await res.json()) as { seq: number };
    const page = await pull(a.token, 'cursor=0');
    expect(page.documents.map((d) => d.id)).toEqual(['n1', 'n2']);
    expect(page.documents[1]!.seq).toBe(seq);
    expect(page.documents[0]!.seq).toBe(seq - 1);
    expect(page.cursor).toBe(seq);
    expect(page.hasMore).toBe(false);
    expect(page.documents[0]!.writer_id).toBe(a.tokenId);
  });

  it('starts the counter at the creation time so recreated apps never go backwards', async () => {
    const before = Date.now() - 1000;
    const { seq } = (await (await push(a.token, [doc('n1', '{}')])).json()) as { seq: number };
    expect(seq).toBeGreaterThan(before);
  });

  it('replaces the writer row on re-push and keeps data opaque', async () => {
    await push(a.token, [doc('n1', 'not json at all', 'notes', 'hlc-1')]);
    await push(a.token, [doc('n1', 'v2', 'notes', 'hlc-2')]);
    const page = await pull(a.token, 'cursor=0');
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0]).toMatchObject({ id: 'n1', data: 'v2', hlc: 'hlc-2' });
  });

  it('keeps one row per writer so siblings come back together', async () => {
    const { token: second, tokenId } = await seedApp('app-a');
    await push(a.token, [doc('n1', 'from a')]);
    await push(second, [doc('n1', 'from b')]);
    const one = await pull(a.token, 'collection=notes&id=n1');
    expect(one.documents.map((d) => [d.writer_id, d.data])).toEqual([
      [a.tokenId, 'from a'],
      [tokenId, 'from b'],
    ]);
  });

  it('filters by one or more collections', async () => {
    await push(a.token, [
      doc('n1', 'x', 'notes'),
      doc('t1', 'y', 'tags'),
      doc('p1', 'z', 'photos'),
    ]);
    expect((await pull(a.token, 'cursor=0&collection=tags')).documents.map((d) => d.id)).toEqual([
      't1',
    ]);
    const two = await pull(a.token, 'cursor=0&collection=tags&collection=photos');
    expect(two.documents.map((d) => d.id)).toEqual(['t1', 'p1']);
  });

  it('never leaks across apps', async () => {
    await push(a.token, [doc('n1', 'secret')]);
    expect((await pull(b.token, 'cursor=0')).documents).toEqual([]);
    expect((await pull(b.token, 'collection=notes&id=n1')).documents).toEqual([]);
  });

  it('validates the push body', async () => {
    expect((await push(a.token, [{ collection: 'notes', id: 'n1' }])).status).toBe(400);
    expect(
      (await api('/sync/push', a.token, { method: 'POST', json: { nope: true } })).status
    ).toBe(400);
    const big = await push(a.token, [doc('n1', 'x'.repeat(1024 * 1024 + 1))]);
    expect(big.status).toBe(413);
    expect(((await big.json()) as { code: string }).code).toBe('document_too_large');
  });

  it('caps the number of documents per push', async () => {
    const docs = Array.from({ length: 51 }, (_, i) => doc(`n${i}`, 'x'));
    const res = await push(a.token, docs);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('too_many_documents');
    expect((await push(a.token, docs.slice(0, 50))).status).toBe(200);
  });

  it('rejects a bad cursor', async () => {
    expect((await api('/sync/pull', a.token)).status).toBe(400);
    expect((await api('/sync/pull?cursor=-1', a.token)).status).toBe(400);
  });
});

describe('blobs', () => {
  it('stores, lists and serves blobs by content hash per app', async () => {
    const a = await seedApp('app-a');
    const b = await seedApp('app-b');
    const bytes = new TextEncoder().encode('hello blob');
    const hash = await sha256Hex(bytes.buffer as ArrayBuffer);

    const wrong = await api(`/sync/blobs/${'0'.repeat(64)}`, a.token, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': 'text/plain' },
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe('hash_mismatch');

    const put = await api(`/sync/blobs/${hash}`, a.token, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': 'text/plain' },
    });
    expect(put.status).toBe(204);
    expect((await api(`/sync/blobs/${hash}`, a.token, { method: 'PUT', body: bytes })).status).toBe(
      204
    );

    const list = (await (await api('/sync/blobs', a.token)).json()) as { hashes: string[] };
    expect(list.hashes).toEqual([hash]);
    const get = await api(`/sync/blobs/${hash}`, a.token);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('text/plain');
    expect(await get.text()).toBe('hello blob');

    expect((await api(`/sync/blobs/${hash}`, b.token)).status).toBe(404);
    expect(
      ((await (await api('/sync/blobs', b.token)).json()) as { hashes: string[] }).hashes
    ).toEqual([]);
    expect((await env.BLOBS.list({ prefix: 'app-b/' })).objects).toEqual([]);
  });

  it('rejects oversized uploads by declared length', async () => {
    const a = await seedApp('app-a');
    const res = await api(`/sync/blobs/${'a'.repeat(64)}`, a.token, {
      method: 'PUT',
      body: 'x',
      headers: { 'content-length': String(51 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
  });
});

describe('CORS', () => {
  it('answers preflights for any origin without a token', async () => {
    const res = await api('/sync/push', null, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://evil.example');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
  });

  it('allows app domains and localhost, and refuses the rest', async () => {
    const a = await seedApp('app-a');
    for (const origin of [
      'https://app.example.test',
      'http://localhost:5173',
      'http://127.0.0.1:8080',
    ]) {
      const res = await api('/auth/check', a.token, { headers: { origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const denied = await api('/auth/check', a.token, {
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(((await denied.json()) as { code: string }).code).toBe('origin_not_allowed');
  });

  it('serves discovery to any origin, since it names no app', async () => {
    const res = await api('/.well-known/pact', null, {
      headers: { origin: 'https://app.example.test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
  });
});

describe('auth endpoints', () => {
  it('describes the token and signs out', async () => {
    const a = await seedApp('app-a');
    const check = (await (await api('/auth/check', a.token)).json()) as Record<string, unknown>;
    expect(check).toEqual({ app_id: 'app-a', user: null, device_name: 'test script' });
    expect((await api('/auth/signout', a.token, { method: 'POST' })).status).toBe(204);
    expect((await api('/auth/check', a.token)).status).toBe(401);
  });

  it('publishes discovery without naming apps', async () => {
    const res = await api('/.well-known/pact', null);
    expect(await res.json()).toEqual({
      version: 2,
      authorize_url: 'https://sync.example.test/oauth/authorize',
      token_url: 'https://sync.example.test/oauth/token',
      max_push_documents: 50,
    });
  });
});

describe('empty push', () => {
  it('returns the current seq without writing', async () => {
    const a = await seedApp('app-a');
    const { seq } = (await (await push(a.token, [doc('n1', 'x')])).json()) as { seq: number };
    const empty = await push(a.token, []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ seq });
  });
});
