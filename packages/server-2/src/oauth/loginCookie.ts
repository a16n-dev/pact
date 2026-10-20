import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../lib/env';
import { LIMITS } from '../lib/limits';

const COOKIE_NAME = 'pact_login';

// Scoped to the authorize path so the session rides along with nothing else the server serves.
const COOKIE_OPTIONS = {
  path: '/oauth/authorize',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
} as const;

export function readLoginCookie(c: Context<{ Bindings: Env }>): string | undefined {
  return getCookie(c, COOKIE_NAME);
}

export function setLoginCookie(c: Context<{ Bindings: Env }>, session: string): void {
  setCookie(c, COOKIE_NAME, session, {
    ...COOKIE_OPTIONS,
    maxAge: Math.floor(LIMITS.loginSessionTtlMs / 1000),
  });
}

export function clearLoginCookie(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, COOKIE_NAME, COOKIE_OPTIONS);
}
