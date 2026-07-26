import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { handlePull, makePushHandler } from './sync/handlers';
import type { SyncHooks } from './sync/api';
import { handleBlobGet, handleBlobList, handleBlobPut } from './sync/blobs';
import {
  bumpClientLastSeen,
  extractBearerToken,
  lookupClientByToken,
  registerClient,
  timingSafeEqual,
  type ClientRow,
} from './auth/auth';
import { isValidAppName, resolveAppAuth, upsertApp } from './apps';

type Variables = { client: ClientRow };

export interface CreateSyncAppOptions {
  hooks?: SyncHooks;
  /**
   * Extra fields merged into the `GET /info` response. The deploy package
   * uses this to advertise capabilities it has wired up on top of the bare
   * sync server (e.g. `{ mcp: true }`). Reserved keys (`name`,
   * `protocolVersion`, `realtime`) cannot be overridden.
   */
  info?: Record<string, unknown>;
}

/**
 * Build the sync HTTP layer as a Hono app. The result is a complete
 * sub-application a deploy package can either export directly (`export
 * default createSyncApp(...)`) or mount inside a larger router. All
 * non-trivial behaviour is reachable programmatically via the named exports
 * above — the HTTP routes here are thin shells over them.
 */
export function createSyncApp(
  options: CreateSyncAppOptions = {}
): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      allowHeaders: ['authorization', 'content-type'],
    })
  );

  app.get('/status', (c) => c.json({ status: 'ok' }));

  app.get('/info', (c) =>
    c.json({
      ...options.info,
      name: c.env.SERVER_NAME,
      protocolVersion: 3,
      realtime: c.env.ENABLE_REALTIME === 'true',
    })
  );

  app.post('/auth/register', async (c) => {
    const password = extractBearerToken(c.req.header('authorization'));
    if (password === null) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req
      .json<{ appName?: unknown; clientId?: unknown; clientName?: unknown }>()
      .catch(() => null);
    if (
      !body ||
      typeof body.appName !== 'string' ||
      typeof body.clientId !== 'string' ||
      typeof body.clientName !== 'string'
    ) {
      return c.json({ error: 'appName, clientId and clientName are required' }, 400);
    }
    const appName = body.appName.trim();
    const clientId = body.clientId.trim();
    const clientName = body.clientName.trim();
    if (!appName || !clientId || !clientName) {
      return c.json({ error: 'appName, clientId and clientName must be non-empty' }, 400);
    }
    if (!isValidAppName(appName)) {
      return c.json({ error: 'appName must match [a-z0-9][a-z0-9_-]{0,63}' }, 400);
    }

    // Looks up the app in the apps table. Unknown app and wrong password are
    // indistinguishable: both burn a full PBKDF2 comparison and both return
    // the same 401 — no probing which app names exist.
    if (!(await resolveAppAuth(c.env, appName, password))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { token } = await registerClient(c.env.DB, appName, clientId, clientName);
    return c.json({ clientId, token });
  });

  // Dynamic app provisioning: create an app (or rotate its password) without
  // touching the APPS secret or redeploying. Guarded by the PROVISION_KEY
  // master secret; disabled entirely when that secret isn't set.
  app.post('/apps', async (c) => {
    if (!c.env.PROVISION_KEY) return c.json({ error: 'disabled' }, 404);
    const key = extractBearerToken(c.req.header('authorization'));
    if (key === null || !(await timingSafeEqual(key, c.env.PROVISION_KEY))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json<{ appName?: unknown; password?: unknown }>().catch(() => null);
    if (!body || typeof body.appName !== 'string' || typeof body.password !== 'string') {
      return c.json({ error: 'appName and password are required' }, 400);
    }
    const appName = body.appName.trim();
    if (!isValidAppName(appName)) {
      return c.json({ error: 'appName must match [a-z0-9][a-z0-9_-]{0,63}' }, 400);
    }
    if (!body.password) {
      return c.json({ error: 'password must be non-empty' }, 400);
    }

    const { created } = await upsertApp(c.env.DB, appName, body.password);
    return c.json({ appName, created }, created ? 201 : 200);
  });

  // WS upgrade needs to authenticate before the standard middleware runs:
  // browser WebSocket APIs can't send an Authorization header, so we also
  // accept a token via `?token=` query param. Header-based auth still works
  // for native clients (e.g. React Native).
  app.get('/realtime', async (c) => {
    if (c.env.ENABLE_REALTIME !== 'true') return c.json({ error: 'disabled' }, 404);
    if (c.req.header('upgrade') !== 'websocket') {
      return c.json({ error: 'expected upgrade: websocket' }, 426);
    }
    const token = c.req.query('token') ?? extractBearerToken(c.req.header('authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const client = await lookupClientByToken(c.env.DB, token);
    if (!client) return c.json({ error: 'Unauthorized' }, 401);
    c.executionCtx.waitUntil(bumpClientLastSeen(c.env.DB, client.appName, client.id));

    // One DO per app: this socket lands in a room that only ever holds its
    // own app's clients, so broadcasts can't cross tenants.
    const id = c.env.REALTIME.idFromName(client.appName);
    return c.env.REALTIME.get(id).fetch(c.req.raw);
  });

  // Auth is path-prefixed (not catch-all) so a parent app/deploy package can
  // mount its own unauthenticated routes alongside without having to reorder
  // middleware. /realtime auths inline because the WS upgrade path needs the
  // token via query param.
  const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
    c,
    next
  ) => {
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const client = await lookupClientByToken(c.env.DB, token);
    if (!client) return c.json({ error: 'Unauthorized' }, 401);
    c.set('client', client);
    // Fire-and-forget — bumping last_seen_at must never block a real request.
    c.executionCtx.waitUntil(bumpClientLastSeen(c.env.DB, client.appName, client.id));
    await next();
  };

  app.use('/auth/check', requireAuth);
  app.use('/sync/*', requireAuth);

  app.get('/auth/check', (c) =>
    c.json({
      ok: true,
      client: { id: c.get('client').id, appName: c.get('client').appName },
    })
  );

  app.post('/sync/push', makePushHandler(options.hooks));
  app.get('/sync/pull', handlePull);
  app.get('/sync/blobs', handleBlobList);
  app.put('/sync/blobs/:hash', handleBlobPut);
  app.get('/sync/blobs/:hash', handleBlobGet);

  // No remote-wipe route: it would let any single client credential erase the
  // whole household database. `wipeAllDocumentsViaApi` / `wipeAllBlobsViaApi`
  // remain exported for trusted server-side/operator use only.

  return app;
}
