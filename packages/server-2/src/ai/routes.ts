import { type Context, Hono } from 'hono';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import { ApiError, badRequest } from '../lib/errors';

export const aiRoutes = new Hono<AuthedEnv>();

aiRoutes.use('*', requireAuth);

aiRoutes.post('/chat/completions', async (c) => {
  const body = await readBody(c);
  if (typeof body.model !== 'string' || !body.model) {
    throw badRequest('model is required');
  }
  return run(c, body.model, body);
});

aiRoutes.post('/run/:provider/:model', async (c) => {
  const { provider, model } = c.req.param();
  return run(c, `${provider}/${model}`, await readBody(c));
});

async function readBody(c: Context<AuthedEnv>): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('body must be a JSON object');
  }
  return body;
}

// Models are `provider/model` and are billed through the account's `default` AI Gateway
// (Unified Billing), so the server holds no provider keys.
async function run(
  c: Context<AuthedEnv>,
  model: string,
  body: Record<string, unknown>
): Promise<Response> {
  const token = c.get('token');
  let upstream: Response;
  try {
    upstream = (await c.env.AI.run(model as never, body, {
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
}
