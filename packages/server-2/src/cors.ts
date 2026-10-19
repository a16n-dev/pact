import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './lib/env';
import { listRedirectUris } from './db/apps';
import { allowedOrigins } from './auth/redirectUris';
import { ApiError, errorResponse } from './lib/errors';

const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Preflights carry no token, so they're answered for any origin. The real check happens on the
// actual request once the app is known.
export function preflight(allowHeaders: 'sync' | 'any'): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (c.req.method !== 'OPTIONS') return next();
    const origin = c.req.header('origin');
    if (!origin) return c.body(null, 204);
    const requested = c.req.header('access-control-request-headers');
    return c.body(null, 204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PUT, DELETE',
      'access-control-allow-headers':
        allowHeaders === 'any' && requested ? requested : 'authorization, content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    });
  };
}

// For routes that name no app, so there is no redirect-URI list to check against
export function allowAnyOrigin<E extends { Bindings: Env }>(c: Context<E>): void {
  const origin = c.req.header('origin');
  if (!origin) return;
  c.header('access-control-allow-origin', origin);
  c.header('vary', 'origin');
}

export async function isOriginAllowed(
  db: D1Database,
  appId: string,
  origin: string
): Promise<boolean> {
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  return allowedOrigins(await listRedirectUris(db, appId)).has(origin);
}

export async function enforceOrigin<E extends { Bindings: Env }>(
  c: Context<E>,
  appId: string
): Promise<Response | null> {
  const origin = c.req.header('origin');
  if (!origin) return null;
  if (!(await isOriginAllowed(c.env.DB, appId, origin))) {
    return errorResponse(
      c,
      new ApiError(403, 'origin_not_allowed', 'This origin is not allowed for the app')
    );
  }
  c.header('access-control-allow-origin', origin);
  c.header('vary', 'origin');
  return null;
}
