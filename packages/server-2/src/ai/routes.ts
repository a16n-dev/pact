import { Hono } from 'hono';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import { ApiError, badRequest } from '../lib/errors';

export const aiRoutes = new Hono<AuthedEnv>();

aiRoutes.use('*', requireAuth);

// Models are `provider/model` and are billed through the account's `default` AI Gateway
// (Unified Billing), so the server holds no provider keys.
aiRoutes.post('/chat/completions', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.model !== 'string' || !body.model) {
    throw badRequest('model is required');
  }
  const token = c.get('token');
  let upstream: Response;
  try {
    upstream = (await c.env.AI.run(body.model as never, body, {
      gateway: { id: 'default', metadata: { app: token.app_id, token: token.id } },
      returnRawResponse: true,
    })) as unknown as Response;
  } catch (error) {
    throw new ApiError(
      502,
      'ai_upstream_error',
      error instanceof Error ? error.message : 'AI request failed'
    );
  }
  if (!upstream.ok && upstream.status >= 500) {
    throw new ApiError(502, 'ai_upstream_error', `AI Gateway returned ${upstream.status}`);
  }
  const headers = new Headers();
  for (const name of ['content-type', 'cache-control']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});
