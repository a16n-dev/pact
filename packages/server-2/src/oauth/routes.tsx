import { Hono } from 'hono';
import type { Env } from '../lib/env';
import { getApp, listRedirectUris } from '../db/apps';
import { createAuthCode } from '../db/authCodes';
import { redirectUriMatches } from '../auth/redirectUris';
import { enforceOrigin } from '../cors';
import { parseAuthorizeParams, parseLoginForm, signIn } from './authorize';
import { type OAuthError, parseTokenRequest, readTokenBody, redeemAuthCode } from './token';
import { LoginPage } from './LoginPage';
import { AuthErrorPage } from './AuthErrorPage';

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

  const form = parseLoginForm(await c.req.parseBody());
  const result = await signIn(c.env, form, c.req.header('cf-connecting-ip'));
  if ('error' in result) {
    return c.html(
      <LoginPage
        host={new URL(c.req.url).host}
        turnstileSiteKey={c.env.TURNSTILE_SITE_KEY}
        username={form.username}
        error={result.error}
      />,
      result.status
    );
  }

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
    user_id: result.user.id,
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

oauthRoutes.post('/token', async (c) => {
  const fail = (error: OAuthError) => c.json({ error }, 400);
  const body = await readTokenBody(c.req);
  if (!body) return fail('invalid_request');
  if (body.grant_type !== 'authorization_code') return fail('unsupported_grant_type');
  const request = parseTokenRequest(body);
  if (!request) return fail('invalid_request');
  const denied = await enforceOrigin(c, request.app_id);
  if (denied) return denied;
  const token = await redeemAuthCode(c.env.DB, request);
  if (!token) return fail('invalid_grant');
  return c.json({ access_token: token, token_type: 'bearer' });
});
