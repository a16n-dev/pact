import type { Env } from './types';

/**
 * App name synthesized when a deployment still uses the single-tenant
 * `API_KEY` secret instead of `APPS` (and hasn't set `DEFAULT_APP_NAME`).
 */
export const LEGACY_DEFAULT_APP = 'default';

/**
 * App names become R2 key prefixes, Durable Object names, and SQL values, so
 * the charset is locked down at the only doors an app name can enter through
 * (register + OAuth). Notably no `/` — that would let one app's blob keys
 * alias into another's prefix.
 */
const APP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Compared against instead of a real password when the requested app doesn't
 * exist, so the response takes the same time either way and the 401 doesn't
 * reveal which app names are provisioned. Never a valid credential:
 * `timingSafeEqual(x, DUMMY_PASSWORD)` is only reached on the unknown-app
 * path, where the result is discarded.
 */
export const DUMMY_PASSWORD = 'pact-dummy-password-for-unknown-apps';

export function isValidAppName(name: string): boolean {
  return APP_NAME_RE.test(name);
}

/**
 * The tenant roster: appName → password. Sourced from the `APPS` secret (a
 * JSON object, set via `wrangler secret put APPS`). When `APPS` is absent, a
 * legacy single-tenant deployment's `API_KEY` is honoured as the password for
 * one app named `DEFAULT_APP_NAME` (or "default"). Misconfiguration throws
 * rather than silently running with zero tenants: a server nobody can
 * register against is a deploy error, not a state to limp along in.
 */
export function getApps(env: Env): Record<string, string> {
  if (env.APPS !== undefined && env.APPS !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.APPS);
    } catch {
      throw new Error('APPS is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('APPS must be a JSON object of { appName: password }');
    }
    const apps: Record<string, string> = {};
    for (const [name, password] of Object.entries(parsed)) {
      if (!isValidAppName(name)) {
        throw new Error(`APPS contains invalid app name: ${JSON.stringify(name)}`);
      }
      if (typeof password !== 'string' || password === '') {
        throw new Error(`APPS password for "${name}" must be a non-empty string`);
      }
      apps[name] = password;
    }
    return apps;
  }
  if (env.API_KEY) {
    return { [env.DEFAULT_APP_NAME ?? LEGACY_DEFAULT_APP]: env.API_KEY };
  }
  throw new Error('No apps configured: set the APPS secret (or legacy API_KEY)');
}

export function getAppPassword(env: Env, appName: string): string | null {
  const apps = getApps(env);
  return Object.prototype.hasOwnProperty.call(apps, appName) ? apps[appName]! : null;
}
