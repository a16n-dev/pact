import type { MiddlewareHandler } from 'hono';
import type { Env } from '../lib/env';
import { verifyAccessJwt } from '../auth/access';

export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const ok = await verifyAccessJwt(
    c.req.header('cf-access-jwt-assertion'),
    c.env.ACCESS_TEAM_DOMAIN,
    c.env.ACCESS_AUD
  );
  if (!ok) return c.text('Sign in through Cloudflare Access to use the admin panel.', 403);
  // A cross-site form post would ride on the Access cookie, so every state change must come from
  // the panel's own origin.
  if (c.req.method !== 'GET' && c.req.header('origin') !== new URL(c.req.url).origin) {
    return c.text('Requests to the admin panel must come from the admin panel.', 403);
  }
  await next();
};
