import { type Context, Hono } from 'hono';
import type { Env } from '../lib/env';
import { getApp, listRedirectUris } from '../db/apps';
import { getUserByUsername } from '../db/users';
import { createAuthCode, consumeAuthCode } from '../db/authCodes';
import { issueDeviceToken } from '../db/tokens';
import { DUMMY_PASSWORD_HASH, sha256Base64url, verifyPassword } from '../lib/crypto';
import { isValidAppId, isValidDeviceId, isValidLabel, isValidUsername } from '../lib/validation';
import { isAllowedRedirectUriForm, redirectUriMatches } from './redirectUris';
import { verifyTurnstile } from './turnstile';
import { enforceOrigin } from '../cors';
import { LoginPage } from '../pages/LoginPage';
import { AuthErrorPage } from '../pages/AuthErrorPage';

type AuthorizeParams = {
  app_id: string;
  redirect_uri: string;
  device_id: string;
  device_name: string;
  state: string;
  code_challenge: string;
};

const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

function parseAuthorizeParams(query: Record<string, string>): AuthorizeParams | null {
  const { app_id, redirect_uri, device_id, device_name, state, code_challenge } = query;
  if (
    !isValidAppId(app_id) ||
    !redirect_uri ||
    !isAllowedRedirectUriForm(redirect_uri) ||
    !isValidDeviceId(device_id) ||
    !isValidLabel(device_name) ||
    !state ||
    state.length > 512 ||
    !code_challenge ||
    !CODE_CHALLENGE_RE.test(code_challenge) ||
    query.code_challenge_method !== 'S256'
  ) {
    return null;
  }
  return { app_id, redirect_uri, device_id, device_name, state, code_challenge };
}

const UNKNOWN_APP_ERROR = {
  title: "This app can't sign in here",
  message:
    "This app, or the address it returns to, isn't set up on this server yet. Ask your server admin to add it, then try signing in again.",
};

const INCOMPLETE_LINK_ERROR = {
  title: 'This sign-in link is incomplete',
  message:
    "Something is missing from the link the app opened, so there's nowhere to send you back to. Try signing in from the app again.",
};

export const oauthRoutes = new Hono<{ Bindings: Env }>();

oauthRoutes.get('/authorize', (c) => {
  const params = parseAuthorizeParams(c.req.query());
  if (!params) return c.html(<AuthErrorPage {...INCOMPLETE_LINK_ERROR} />, 400);
  return c.html(
    <LoginPage host={new URL(c.req.url).host} turnstileSiteKey={c.env.TURNSTILE_SITE_KEY} />
  );
});

// Credentials are checked before the app and redirect URI, so the login page behaves the same
// whatever the app ID and reveals nothing about which apps exist.
oauthRoutes.post('/authorize', async (c) => {
  const params = parseAuthorizeParams(c.req.query());
  if (!params) return c.html(<AuthErrorPage {...INCOMPLETE_LINK_ERROR} />, 400);

  const form = await c.req.parseBody();
  const username = typeof form.username === 'string' ? form.username.trim() : '';
  const password = typeof form.password === 'string' ? form.password : '';
  const turnstileResponse =
    typeof form['cf-turnstile-response'] === 'string' ? form['cf-turnstile-response'] : undefined;
  const ip = c.req.header('cf-connecting-ip');

  const page = (error: string, status: 401 | 429) =>
    c.html(
      <LoginPage
        host={new URL(c.req.url).host}
        turnstileSiteKey={c.env.TURNSTILE_SITE_KEY}
        username={username}
        error={error}
      />,
      status
    );

  const [byIp, byUser] = await Promise.all([
    c.env.LOGIN_LIMITER.limit({ key: `ip:${ip ?? 'unknown'}` }),
    c.env.LOGIN_LIMITER.limit({ key: `user:${username}` }),
  ]);
  if (!byIp.success || !byUser.success) {
    return page('Too many sign-in attempts. Wait a minute, then try again.', 429);
  }
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET, turnstileResponse, ip))) {
    return page("We couldn't confirm you're human. Try signing in again.", 401);
  }

  const user = isValidUsername(username) ? await getUserByUsername(c.env.DB, username) : null;
  const passwordOk = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) return page('Username or password is incorrect.', 401);

  const app = await getApp(c.env.DB, params.app_id);
  const registered = app ? await listRedirectUris(c.env.DB, app.id) : [];
  if (!app || !redirectUriMatches(registered, params.redirect_uri)) {
    return c.html(
      <AuthErrorPage
        {...UNKNOWN_APP_ERROR}
        appId={params.app_id}
        redirectUri={params.redirect_uri}
      />,
      400
    );
  }

  const code = await createAuthCode(c.env.DB, {
    app_id: app.id,
    user_id: user.id,
    device_id: params.device_id,
    device_name: params.device_name,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
  });
  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', params.state);
  return c.redirect(target.href, 303);
});

type OAuthError = 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type';

async function readTokenBody(c: Context<{ Bindings: Env }>) {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  }
  return c.req.parseBody().catch(() => null) as Promise<Record<string, unknown> | null>;
}

oauthRoutes.post('/token', async (c) => {
  const fail = (error: OAuthError) => c.json({ error }, 400);
  const body = await readTokenBody(c);
  if (!body) return fail('invalid_request');
  if (body.grant_type !== 'authorization_code') return fail('unsupported_grant_type');
  const { code, code_verifier, redirect_uri, app_id } = body;
  if (
    typeof code !== 'string' ||
    typeof code_verifier !== 'string' ||
    typeof redirect_uri !== 'string' ||
    !isValidAppId(app_id)
  ) {
    return fail('invalid_request');
  }
  const denied = await enforceOrigin(c, app_id);
  if (denied) return denied;

  const grant = await consumeAuthCode(c.env.DB, code);
  if (
    !grant ||
    grant.app_id !== app_id ||
    grant.redirect_uri !== redirect_uri ||
    grant.code_challenge !== (await sha256Base64url(code_verifier))
  ) {
    return fail('invalid_grant');
  }
  const token = await issueDeviceToken(
    c.env.DB,
    grant.app_id,
    grant.user_id,
    grant.device_id,
    grant.device_name
  );
  return c.json({ access_token: token, token_type: 'bearer' });
});
