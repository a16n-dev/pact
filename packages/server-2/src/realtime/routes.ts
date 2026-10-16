import { Hono } from 'hono';
import type { Env } from '../lib/env';
import { ApiError } from '../lib/errors';
import { authenticate } from '../auth/bearer';
import { isOriginAllowed } from '../cors';
import { TOKEN_ID_HEADER } from './durableObject';

export const realtimeRoutes = new Hono<{ Bindings: Env }>();

// Browsers can't send headers on a WebSocket upgrade, so the token rides in the query string.
realtimeRoutes.get('/', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected a WebSocket upgrade', code: 'bad_request' }, 426);
  }
  const token = await authenticate(c.env, c.req.query('token') ?? null, (p) =>
    c.executionCtx.waitUntil(p)
  );
  if (!token) throw new ApiError(401, 'unauthorized', 'A valid token is required');
  const origin = c.req.header('origin');
  if (origin && !(await isOriginAllowed(c.env.DB, token.app_id, origin))) {
    throw new ApiError(403, 'origin_not_allowed', 'This origin is not allowed for the app');
  }
  // The DO trusts this header, so it must come from here and never from the client.
  const headers = new Headers(c.req.raw.headers);
  headers.set(TOKEN_ID_HEADER, token.id);
  return c.env.REALTIME.get(c.env.REALTIME.idFromName(token.app_id)).fetch(
    new Request(c.req.raw, { headers })
  );
});
