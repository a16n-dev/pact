import { Hono } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import type { Env } from '../lib/env';
import { ApiError } from '../lib/errors';
import { getApp } from '../db/apps';

export const aiRoutes = new Hono<AuthedEnv>();

aiRoutes.use('*', requireAuth);

const MOUNT_PATH = '/ai';

// The Pact token must not reach the gateway, a client-supplied provider key would bypass
// Unified Billing, and client `cf-*` headers could override the gateway's own settings.
function isForwardedRequestHeader(name: string): boolean {
  return (
    !['authorization', 'x-api-key', 'cookie', 'host', 'origin'].includes(name) &&
    !name.startsWith('cf-')
  );
}

// CORS headers are the server's to set, and the runtime re-derives the framing headers for the
// body it sends.
function isForwardedResponseHeader(name: string): boolean {
  return (
    !['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name) &&
    !name.startsWith('access-control-')
  );
}

function gatewayConfig(env: Env): { account: string; gateway: string; token: string } {
  const { CLOUDFLARE_ACCOUNT_ID: account, AI_GATEWAY_ID: gateway, AI_GATEWAY_TOKEN: token } = env;
  if (!account || !gateway || !token) {
    throw new ApiError(503, 'ai_not_configured', 'This server has no AI Gateway configured');
  }
  return { account, gateway, token };
}

aiRoutes.all('/*', async (c) => {
  const { account, gateway, token } = gatewayConfig(c.env);
  const pactToken = c.get('token');
  const app = await getApp(c.env.DB, pactToken.app_id);
  if (app?.ai_proxy !== 1) {
    throw new ApiError(403, 'ai_disabled', 'AI is turned off for this app');
  }
  const url = new URL(c.req.url);
  const upstreamPath = url.pathname.slice(MOUNT_PATH.length);
  const upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}${upstreamPath}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers) {
    if (isForwardedRequestHeader(name)) headers.set(name, value);
  }
  headers.set('cf-aig-authorization', `Bearer ${token}`);
  headers.set('cf-aig-metadata', JSON.stringify({ app: pactToken.app_id, token: pactToken.id }));

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method: c.req.method, headers, body: c.req.raw.body });
  } catch (error) {
    throw new ApiError(
      502,
      'ai_upstream_error',
      error instanceof Error ? error.message : 'AI request failed'
    );
  }
  if (upstream.status >= 500) {
    throw new ApiError(502, 'ai_upstream_error', `AI Gateway returned ${upstream.status}`);
  }
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    if (isForwardedResponseHeader(name)) responseHeaders[name] = value;
  }
  return c.newResponse(upstream.body, upstream.status as StatusCode, responseHeaders);
});
