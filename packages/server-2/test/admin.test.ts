import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { api, doc, ORIGIN, push, seedApp, seedUser } from './helpers';
import { base64url, sha256Hex } from '../src/lib/crypto';
import { getApp } from '../src/db/apps';
import { issueDeviceToken, mintApiToken } from '../src/db/tokens';

const TEAM = 'test.cloudflareaccess.com';
const AUD = 'aud-123';
let privateKey: CryptoKey;

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  privateKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  fetchMock
    .get(`https://${TEAM}`)
    .intercept({ path: '/cdn-cgi/access/certs' })
    .reply(200, { keys: [{ ...jwk, kid: 'k1' }] })
    .persist();
});

async function jwt(claims: Record<string, unknown> = {}): Promise<string> {
  const encode = (obj: unknown) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const head = encode({ alg: 'RS256', kid: 'k1' });
  const body = encode({
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${base64url(new Uint8Array(sig))}`;
}

async function admin(
  path: string,
  init: RequestInit & { form?: Record<string, string>; noOrigin?: boolean } = {}
) {
  const headers = new Headers(init.headers);
  headers.set('cf-access-jwt-assertion', await jwt());
  let body = init.body;
  if (init.form) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(init.form);
    if (!init.noOrigin && !headers.has('origin')) headers.set('origin', ORIGIN);
  }
  return SELF.fetch(`${ORIGIN}/admin${path}`, { ...init, headers, body, redirect: 'manual' });
}

describe('Cloudflare Access', () => {
  it('refuses requests without a valid Access token', async () => {
    expect((await SELF.fetch(`${ORIGIN}/admin/apps`)).status).toBe(403);
    const wrongAud = await SELF.fetch(`${ORIGIN}/admin/apps`, {
      headers: { 'cf-access-jwt-assertion': await jwt({ aud: ['other'] }) },
    });
    expect(wrongAud.status).toBe(403);
    const expired = await SELF.fetch(`${ORIGIN}/admin/apps`, {
      headers: {
        'cf-access-jwt-assertion': await jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
      },
    });
    expect(expired.status).toBe(403);
    expect((await admin('/apps')).status).toBe(200);
  });

  it('refuses state changes that do not come from the panel origin', async () => {
    const res = await admin('/apps', {
      method: 'POST',
      form: { name: 'X', id: 'x' },
      noOrigin: true,
    });
    expect(res.status).toBe(403);
    const crossSite = await admin('/apps', {
      method: 'POST',
      form: { name: 'X', id: 'x' },
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM apps').first<{ n: number }>()).toEqual({
      n: 0,
    });
  });
});

describe('apps and users', () => {
  it('creates an app and shows it with its counts', async () => {
    const created = await admin('/apps', {
      method: 'POST',
      form: { name: 'Recipe Box', id: 'recipe-box' },
    });
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/admin/apps/recipe-box/settings');

    const dup = await admin('/apps', { method: 'POST', form: { name: 'Again', id: 'recipe-box' } });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('An app with this ID already exists.');
    const badId = await admin('/apps', { method: 'POST', form: { name: 'Bad', id: 'Not Valid' } });
    expect(badId.status).toBe(400);

    const html = await (await admin('/apps')).text();
    expect(html).toContain('Recipe Box');
    expect(html).toContain('recipe-box');
  });

  it('creates users, resets passwords and deletes them with their tokens', async () => {
    const short = await admin('/users', {
      method: 'POST',
      form: { username: 'jo', password: 'short' },
    });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain('at least 8 characters');
    expect(
      (
        await admin('/users', {
          method: 'POST',
          form: { username: 'jo', password: 'hunter2hunter2' },
        })
      ).status
    ).toBe(303);
    expect(
      (
        await admin('/users', {
          method: 'POST',
          form: { username: 'jo', password: 'hunter2hunter2' },
        })
      ).status
    ).toBe(400);

    const user = await env.DB.prepare('SELECT id, password_hash FROM users').first<{
      id: string;
      password_hash: string;
    }>();
    expect(
      (
        await admin(`/users/${user!.id}/password`, {
          method: 'POST',
          form: { password: 'newpassword1' },
        })
      ).status
    ).toBe(303);
    const after = await env.DB.prepare('SELECT password_hash FROM users').first<{
      password_hash: string;
    }>();
    expect(after!.password_hash).not.toBe(user!.password_hash);

    expect((await admin(`/users/${user!.id}/delete`, { method: 'POST', form: {} })).status).toBe(
      303
    );
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 0 });
  });
});

describe('inside an app', () => {
  let a: Awaited<ReturnType<typeof seedApp>>;
  beforeEach(async () => {
    a = await seedApp('app-a');
  });

  it('mints an API token once and lists it by prefix', async () => {
    const res = await admin('/apps/app-a/access/tokens', {
      method: 'POST',
      form: { label: 'MCP server' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = html.match(/value="(pact_[A-Za-z0-9_-]+)"/)![1]!;
    expect((await api('/auth/check', token)).status).toBe(200);
    const list = await (await admin('/apps/app-a/access')).text();
    expect(list).toContain('MCP server');
    expect(list).toContain(`${token.slice(0, 9)}…`);
    expect(list).not.toContain(token);
  });

  it('revokes tokens', async () => {
    expect(
      (await admin(`/apps/app-a/access/tokens/${a.tokenId}/revoke`, { method: 'POST', form: {} }))
        .status
    ).toBe(303);
    expect((await api('/auth/check', a.token)).status).toBe(401);
  });

  it('restricts sign-in to listed users and signs out anyone removed', async () => {
    await seedUser('alex');
    await seedUser('jo');
    const users = await env.DB.prepare('SELECT id, username FROM users ORDER BY username').all<{
      id: string;
      username: string;
    }>();
    const [alex, jo] = users.results;
    const alexToken = await issueDeviceToken(env.DB, 'app-a', alex!.id, 'device-1', 'Phone');

    expect(
      (await admin('/apps/app-a/access/restrict', { method: 'POST', form: { enabled: 'on' } }))
        .status
    ).toBe(303);
    expect((await getApp(env.DB, 'app-a'))!.restricted).toBe(1);
    let html = await (await admin('/apps/app-a/access')).text();
    expect(html).toContain('Remove alex');
    expect(html).not.toContain('Remove jo');

    const unknown = await admin('/apps/app-a/access/users', {
      method: 'POST',
      form: { user_id: 'nobody' },
    });
    expect(unknown.status).toBe(400);
    expect(
      (await admin('/apps/app-a/access/users', { method: 'POST', form: { user_id: jo!.id } }))
        .status
    ).toBe(303);
    html = await (await admin('/apps/app-a/access')).text();
    expect(html).toContain('Remove jo');

    expect((await api('/auth/check', alexToken)).status).toBe(200);
    expect(
      (
        await admin('/apps/app-a/access/users/remove', {
          method: 'POST',
          form: { user_id: alex!.id },
        })
      ).status
    ).toBe(303);
    expect((await api('/auth/check', alexToken)).status).toBe(401);
    html = await (await admin('/apps/app-a/access')).text();
    expect(html).not.toContain('Remove alex');

    expect((await admin('/apps/app-a/access/restrict', { method: 'POST', form: {} })).status).toBe(
      303
    );
    expect((await getApp(env.DB, 'app-a'))!.restricted).toBe(0);
  });

  it('manages redirect URIs and renames', async () => {
    const bad = await admin('/apps/app-a/redirect-uris', {
      method: 'POST',
      form: { uri: 'ftp://x' },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await admin('/apps/app-a/redirect-uris', {
          method: 'POST',
          form: { uri: 'com.example.app:/cb' },
        })
      ).status
    ).toBe(303);
    expect(
      (await admin('/apps/app-a/rename', { method: 'POST', form: { name: 'Renamed' } })).status
    ).toBe(303);
    const html = await (await admin('/apps/app-a/settings')).text();
    expect(html).toContain('com.example.app:/cb');
    expect(html).toContain('Renamed');
    expect(
      (
        await admin('/apps/app-a/redirect-uris/remove', {
          method: 'POST',
          form: { uri: 'com.example.app:/cb' },
        })
      ).status
    ).toBe(303);
    expect(await (await admin('/apps/app-a/settings')).text()).not.toContain('com.example.app:/cb');
  });

  it('manages app domains, adding one for each https redirect URI', async () => {
    const bad = await admin('/apps/app-a/origins', { method: 'POST', form: { domain: 'nope' } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('served over https');
    expect(
      (await admin('/apps/app-a/origins', { method: 'POST', form: { domain: 'web.example.test' } }))
        .status
    ).toBe(303);
    expect(
      (
        await admin('/apps/app-a/redirect-uris', {
          method: 'POST',
          form: { uri: 'https://other.example.test/auth/cb' },
        })
      ).status
    ).toBe(303);
    const html = await (await admin('/apps/app-a/settings')).text();
    expect(html).toContain('Remove https://web.example.test');
    expect(html).toContain('Remove https://other.example.test');
    for (const origin of ['https://web.example.test', 'https://other.example.test']) {
      expect((await api('/auth/check', a.token, { headers: { origin } })).status).toBe(200);
    }
    expect(
      (
        await admin('/apps/app-a/origins/remove', {
          method: 'POST',
          form: { origin: 'https://web.example.test' },
        })
      ).status
    ).toBe(303);
    expect(
      (await api('/auth/check', a.token, { headers: { origin: 'https://web.example.test' } }))
        .status
    ).toBe(403);
  });

  it('switches localhost redirects on and off instead of registering them', async () => {
    const loopback = await admin('/apps/app-a/redirect-uris', {
      method: 'POST',
      form: { uri: 'http://localhost:3000/cb' },
    });
    expect(loopback.status).toBe(400);
    expect(await loopback.text()).toContain('Allow localhost');

    expect((await admin('/apps/app-a/localhost', { method: 'POST', form: {} })).status).toBe(303);
    expect((await getApp(env.DB, 'app-a'))!.allow_localhost).toBe(0);
    expect(
      (await admin('/apps/app-a/localhost', { method: 'POST', form: { enabled: 'on' } })).status
    ).toBe(303);
    expect((await getApp(env.DB, 'app-a'))!.allow_localhost).toBe(1);
  });

  it('switches the AI proxy off and on, starting on', async () => {
    expect((await getApp(env.DB, 'app-a'))!.ai_proxy).toBe(1);
    expect((await admin('/apps/app-a/ai-proxy', { method: 'POST', form: {} })).status).toBe(303);
    expect((await getApp(env.DB, 'app-a'))!.ai_proxy).toBe(0);
    expect(
      (await admin('/apps/app-a/ai-proxy', { method: 'POST', form: { enabled: 'on' } })).status
    ).toBe(303);
    expect((await getApp(env.DB, 'app-a'))!.ai_proxy).toBe(1);
  });

  it('summarises documents by collection', async () => {
    await push(a.token, [doc('n1', 'one'), doc('n2', 'two'), doc('r1', 'rice', 'recipes')]);
    expect((await admin('/apps/app-a')).headers.get('location')).toBe(
      '/admin/apps/app-a/documents'
    );
    const html = await (await admin('/apps/app-a/documents')).text();
    expect(html).toContain('notes');
    expect(html).toContain('recipes');
    expect(html).toMatch(/Documents<\/div>\s*<div class="stat-value">3</);
  });

  it("browses a collection and decodes a document's versions", async () => {
    const record = (title: string, clock: string) =>
      JSON.stringify({
        schemaVersion: 2,
        fields: { id: 'n1', createdAt: '2026-01-01T00:00:00.000Z', title },
        clocks: { title: clock },
      });
    const older = '1767225600000-0000-devA';
    const newer = '1767225660000-0000-devB';
    await push(a.token, [doc('n1', record('Rice <3', newer), 'notes', newer), doc('n2', 'x')]);
    const other = await mintApiToken(env.DB, 'app-a', 'importer');
    await push(other.token, [doc('n1', record('Old title', older), 'notes', older)]);
    await push(other.token, [doc('n3', 'pactenc$abc', 'notes', older)]);

    const list = await (await admin('/apps/app-a/documents/notes')).text();
    expect(list).toContain('href="/admin/apps/app-a/documents/notes/n1"');
    expect(list).toContain('n2');
    expect(list).toContain('3 documents');

    const page = await (await admin('/apps/app-a/documents/notes/n1')).text();
    expect(page).toContain('Current value');
    expect(page).toContain('&quot;Rice &lt;3&quot;');
    expect(page).toContain('&quot;Old title&quot;');
    expect(page).toContain('test script');
    expect(page).toContain('importer');
    expect(page).toContain('1 Jan 2026');
    expect(page).toContain('devB');

    const sealed = await (await admin('/apps/app-a/documents/notes/n3')).text();
    expect(sealed).toContain('Encrypted on the device');

    expect((await admin('/apps/app-a/documents/notes/missing')).status).toBe(404);
    expect((await admin('/apps/app-a/documents/missing')).status).toBe(404);
  });

  it('lists and downloads blobs', async () => {
    const bytes = new TextEncoder().encode('blob');
    const hash = await sha256Hex(bytes.buffer as ArrayBuffer);
    await api(`/sync/blobs/${hash}`, a.token, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': 'image/png' },
    });
    const html = await (await admin('/apps/app-a/blobs')).text();
    expect(html).toContain('image/png');
    expect(html).toContain('1 blobs · 4 B');
    const download = await admin(`/apps/app-a/blobs/${hash}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('blob');
  });

  it('wipes data but keeps tokens, and bumps nothing backwards', async () => {
    const { seq } = (await (await push(a.token, [doc('n1', 'x')])).json()) as { seq: number };
    const bytes = new TextEncoder().encode('blob');
    const hash = await sha256Hex(bytes.buffer as ArrayBuffer);
    await api(`/sync/blobs/${hash}`, a.token, { method: 'PUT', body: bytes });
    expect((await admin('/apps/app-a/wipe', { method: 'POST', form: {} })).status).toBe(303);
    const pull = (await (await api('/sync/pull?cursor=0', a.token)).json()) as {
      documents: unknown[];
    };
    expect(pull.documents).toEqual([]);
    expect((await env.BLOBS.list({ prefix: 'app-a/' })).objects).toEqual([]);
    const { seq: next } = (await (await push(a.token, [doc('n1', 'y')])).json()) as { seq: number };
    expect(next).toBeGreaterThan(seq);
  });

  it('deletes the app only when its ID is typed', async () => {
    await push(a.token, [doc('n1', 'x')]);
    const wrong = await admin('/apps/app-a/delete', { method: 'POST', form: { confirm: 'nope' } });
    expect(wrong.status).toBe(400);
    expect((await api('/auth/check', a.token)).status).toBe(200);
    const res = await admin('/apps/app-a/delete', { method: 'POST', form: { confirm: 'app-a' } });
    expect(res.status).toBe(303);
    expect((await api('/auth/check', a.token)).status).toBe(401);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM documents').first()).toEqual({ n: 0 });
    expect((await admin('/apps/app-a/settings')).status).toBe(404);
  });
});
