import { Hono } from 'hono';
import { type AuthedEnv, requireAuth } from './bearer';
import { deleteToken } from '../db/tokens';
import { notifyRealtime } from '../realtime/durableObject';

export const authRoutes = new Hono<AuthedEnv>();

authRoutes.use('*', requireAuth);

authRoutes.get('/check', (c) => {
  const token = c.get('token');
  return c.json({ app_id: token.app_id, user: token.username, device_name: token.label });
});

authRoutes.post('/signout', async (c) => {
  const token = c.get('token');
  await deleteToken(c.env.DB, token.app_id, token.id);
  c.executionCtx.waitUntil(notifyRealtime(c.env, token.app_id, (rt) => rt.closeToken(token.id)));
  return c.body(null, 204);
});
