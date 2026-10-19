import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { api, ORIGIN, randomVerifier, seedApp, seedUser } from './helpers';
import { sha256Base64url } from '../src/lib/crypto';
import { setAllowLocalhost } from '../src/db/apps';
import { addAppUser, setRestricted } from '../src/db/appUsers';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

function mockTurnstile(success: boolean) {
  fetchMock
    .get('https://challenges.cloudflare.com')
    .intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
    .reply(200, { success });
}

type Flow = {
  verifier: string;
  authorizeUrl: string;
  redirectUri: string;
};

async function startFlow(
  appId = 'app-a',
  redirectUri = 'https://app.example.test/callback'
): Promise<Flow> {
  const verifier = randomVerifier();
  const params = new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    device_id: 'device-1',
    device_name: "Alex's iPhone",
    state: 'xyz',
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: 'S256',
  });
  return { verifier, authorizeUrl: `${ORIGIN}/oauth/authorize?${params}`, redirectUri };
}

function login(flow: Flow, username: string, password: string, ip = '203.0.113.1') {
  return SELF.fetch(flow.authorizeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    body: new URLSearchParams({ username, password, 'cf-turnstile-response': 'tok' }),
    redirect: 'manual',
  });
}

async function exchange(flow: Flow, code: string, appId = 'app-a', verifier = flow.verifier) {
  return api('/oauth/token', null, {
    method: 'POST',
    json: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: flow.redirectUri,
      app_id: appId,
    },
  });
}

describe('sign-in', () => {
  beforeEach(async () => {
    await seedApp('app-a');
    await seedUser();
  });

  it('renders the login form for any app id', async () => {
    const flow = await startFlow('no-such-app');
    const res = await SELF.fetch(flow.authorizeUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in to sync');
    expect(html).toContain('cf-turnstile');
    expect(html).not.toContain('no-such-app');
  });

  it('refuses an incomplete link without redirecting', async () => {
    const res = await SELF.fetch(`${ORIGIN}/oauth/authorize?app_id=app-a`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('This sign-in link is incomplete');
    expect(html).toContain('Back to the app');
  });

  it('completes the code exchange and rotates the token on the same row', async () => {
    mockTurnstile(true);
    const flow = await startFlow();
    const res = await login(flow, 'alex', 'correcthorse');
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://app.example.test/callback');
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code')!;

    const tokenRes = await exchange(flow, code);
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    expect(access_token).toMatch(/^pact_/);

    const check = (await (await api('/auth/check', access_token)).json()) as Record<
      string,
      unknown
    >;
    expect(check).toEqual({ app_id: 'app-a', user: 'alex', device_name: "Alex's iPhone" });
    const firstRow = await env.DB.prepare('SELECT id FROM tokens WHERE user_id IS NOT NULL').first<{
      id: string;
    }>();

    expect((await exchange(flow, code)).status).toBe(400);

    mockTurnstile(true);
    const again = await startFlow();
    const code2 = new URL(
      (await login(again, 'alex', 'correcthorse')).headers.get('location')!
    ).searchParams.get('code')!;
    const { access_token: rotated } = (await (await exchange(again, code2)).json()) as {
      access_token: string;
    };
    expect(rotated).not.toBe(access_token);
    expect((await api('/auth/check', access_token)).status).toBe(401);
    expect((await api('/auth/check', rotated)).status).toBe(200);
    const rows = await env.DB.prepare('SELECT id FROM tokens WHERE user_id IS NOT NULL').all<{
      id: string;
    }>();
    expect(rows.results).toEqual([firstRow]);
  });

  it('shows a generic error for bad credentials and unknown users alike', async () => {
    mockTurnstile(true);
    const flow = await startFlow();
    const wrong = await login(flow, 'alex', 'wrongpassword');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Username or password is incorrect.');
    mockTurnstile(true);
    const unknown = await login(flow, 'nobody', 'correcthorse');
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toContain('Username or password is incorrect.');
  });

  it('turns away users outside a restricted app with the generic credentials error', async () => {
    await seedUser('sam', 'correcthorse');
    await setRestricted(env.DB, 'app-a', true);
    const ip = '198.51.100.9';
    mockTurnstile(true);
    const denied = await login(await startFlow(), 'sam', 'correcthorse', ip);
    expect(denied.status).toBe(401);
    expect(await denied.text()).toContain('Username or password is incorrect.');

    const sam = await env.DB.prepare("SELECT id FROM users WHERE username = 'sam'").first<{
      id: string;
    }>();
    await addAppUser(env.DB, 'app-a', sam!.id);
    mockTurnstile(true);
    expect((await login(await startFlow(), 'sam', 'correcthorse', ip)).status).toBe(303);

    await setRestricted(env.DB, 'app-a', false);
    await env.DB.prepare('DELETE FROM app_users').run();
    mockTurnstile(true);
    expect((await login(await startFlow(), 'sam', 'correcthorse', ip)).status).toBe(303);
  });

  it('fails closed when Turnstile rejects', async () => {
    mockTurnstile(false);
    const res = await login(await startFlow(), 'alex', 'correcthorse');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('confirm you');
  });

  it('shows an error page instead of redirecting for an unknown app or redirect URI', async () => {
    mockTurnstile(true);
    const unknownApp = await login(await startFlow('ghost'), 'alex', 'correcthorse');
    expect(unknownApp.status).toBe(400);
    expect(unknownApp.headers.get('location')).toBeNull();
    const html = await unknownApp.text();
    expect(html).toContain('sign in here');
    expect(html).toContain('ghost');

    mockTurnstile(true);
    const badUri = await login(
      await startFlow('app-a', 'https://evil.example/cb'),
      'alex',
      'correcthorse'
    );
    expect(badUri.status).toBe(400);
    expect(await badUri.text()).toContain('https://evil.example/cb');
  });

  it('accepts any loopback redirect URI only while the app allows localhost', async () => {
    mockTurnstile(true);
    const res = await login(
      await startFlow('app-a', 'http://localhost:5173/callback'),
      'alex',
      'correcthorse'
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^http:\/\/localhost:5173\/callback\?code=/);

    await setAllowLocalhost(env.DB, 'app-a', false);
    mockTurnstile(true);
    const refused = await login(
      await startFlow('app-a', 'http://127.0.0.1:5173/callback'),
      'alex',
      'correcthorse'
    );
    expect(refused.status).toBe(400);
  });

  it('rejects a code with the wrong verifier, app or redirect URI', async () => {
    mockTurnstile(true);
    const flow = await startFlow();
    const code = new URL(
      (await login(flow, 'alex', 'correcthorse')).headers.get('location')!
    ).searchParams.get('code')!;
    const bad = await exchange(flow, code, 'app-a', randomVerifier());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_grant' });
    expect((await exchange(flow, code)).status).toBe(400);
  });

  it('uses the OAuth error shape for malformed token requests', async () => {
    const res = await api('/oauth/token', null, {
      method: 'POST',
      json: { grant_type: 'password' },
    });
    expect(await res.json()).toEqual({ error: 'unsupported_grant_type' });
    const missing = await api('/oauth/token', null, {
      method: 'POST',
      json: { grant_type: 'authorization_code' },
    });
    expect(await missing.json()).toEqual({ error: 'invalid_request' });
  });

  it('rate limits repeated attempts', async () => {
    const flow = await startFlow();
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      mockTurnstile(true);
      last = (await login(flow, 'alex', 'wrongpassword', '198.51.100.7')).status;
    }
    expect(last).toBe(429);
  });
});
