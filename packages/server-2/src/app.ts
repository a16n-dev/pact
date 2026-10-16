import { Hono } from 'hono';
import type { Env } from './env';
import { maxPushDocuments } from './env';
import { ApiError, errorResponse } from './errors';

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

app.notFound((c) => errorResponse(c, new ApiError(404, 'not_found', 'No such route')));

app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(c, error);
  console.error(error);
  return c.json({ error: 'Something went wrong', code: 'internal_error' }, 500);
});
