import { Hono } from 'hono';
import type { Env } from './lib/env';
import { maxPushDocuments } from './lib/env';
import { ApiError, errorResponse } from './lib/errors';
import { preflight, isOriginAllowed } from './cors';
import { authenticate } from './auth/bearer';
import { authRoutes } from './auth/routes';
import { syncRoutes } from './sync/routes';
import { TOKEN_ID_HEADER } from './realtime';

export const app = new Hono<{ Bindings: Env }>();

app.get('/.well-known/pact', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    version: 2,
    authorize_url: `${origin}/oauth/authorize`,
    token_url: `${origin}/oauth/token`,
    max_push_documents: maxPushDocuments(c.env),
  });
});

app.use('/auth/*', preflight('sync'));
app.use('/sync/*', preflight('sync'));

app.route('/auth', authRoutes);
app.route('/sync', syncRoutes);

// Browsers can't send headers on a WebSocket upgrade, so the token rides in the query string.
app.get('/realtime', async (c) => {
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

app.notFound((c) => errorResponse(c, new ApiError(404, 'not_found', 'No such route')));

app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(c, error);
  console.error(error);
  return c.json({ error: 'Something went wrong', code: 'internal_error' }, 500);
});
