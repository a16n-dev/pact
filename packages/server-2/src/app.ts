import { Hono } from 'hono';
import type { Env } from './lib/env';
import { maxPushDocuments } from './lib/env';
import { ApiError, errorResponse } from './lib/errors';
import { preflight } from './cors';
import { oauthRoutes } from './oauth/routes';
import { authRoutes } from './auth/routes';
import { syncRoutes } from './sync/routes';
import { realtimeRoutes } from './realtime/routes';
import { adminRoutes } from './admin/routes';

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

app.use('/oauth/token', preflight('sync'));
app.use('/auth/*', preflight('sync'));
app.use('/sync/*', preflight('sync'));

app.route('/oauth', oauthRoutes);
app.route('/auth', authRoutes);
app.route('/sync', syncRoutes);
app.route('/realtime', realtimeRoutes);
app.route('/admin', adminRoutes);

app.notFound((c) => errorResponse(c, new ApiError(404, 'not_found', 'No such route')));

app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(c, error);
  console.error(error);
  return c.json({ error: 'Something went wrong', code: 'internal_error' }, 500);
});
