import type { MiddlewareHandler } from 'hono';
import type { Env } from '../lib/env';
import { lookupToken, touchToken, type TokenWithUser } from '../db/tokens';
import { ApiError, errorResponse } from '../lib/errors';
import { enforceOrigin } from '../cors';

export type AuthedEnv = { Bindings: Env; Variables: { token: TokenWithUser } };

function extractBearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

export async function authenticate(
  env: Env,
  token: string | null,
  waitUntil: (p: Promise<unknown>) => void
): Promise<TokenWithUser | null> {
  if (!token) return null;
  const row = await lookupToken(env.DB, token);
  if (!row) return null;
  waitUntil(touchToken(env.DB, row));
  return row;
}

export const requireAuth: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  const row = await authenticate(c.env, extractBearerToken(c.req.header('authorization')), (p) =>
    c.executionCtx.waitUntil(p)
  );
  if (!row) {
    return errorResponse(c, new ApiError(401, 'unauthorized', 'A valid bearer token is required'));
  }
  const denied = await enforceOrigin(c, row.app_id);
  if (denied) return denied;
  c.set('token', row);
  await next();
};
