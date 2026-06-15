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

export { RealtimeDO } from './realtime';
export { D1Adapter, type D1AdapterOptions } from './d1Adapter';
export { createLandingApp, type LandingOptions } from './landing/landing';
export {
  createOAuthAuthApp,
  type OAuthAuthOptions,
  type OAuthAuthBranding,
  type AuthIdentity,
} from './auth/oauthAuth';
export type { Env, SyncDocument, PushRequest, PushResponse, PullResponse } from './types';
export type { ClientRow } from './auth/auth';
export {
  pushDocuments,
  pullDocument,
  pullDocumentsSince,
  wipeAllDocumentsViaApi,
  wipeAllBlobsViaApi,
  getBlob,
  putBlob,
  listBlobs,
} from './sync/api';
export type { SyncHooks, PushOptions, PushOutcome, PushResult } from './sync/api';
export {
  bumpClientLastSeen,
  extractBearerToken,
  lookupClientByToken,
  registerClient,
  timingSafeEqual,
} from './auth/auth';

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
      protocolVersion: 2,
      realtime: c.env.ENABLE_REALTIME === 'true',
    })
  );

  app.post('/auth/register', async (c) => {
    const password = extractBearerToken(c.req.header('authorization'));
    if (password === null || !(await timingSafeEqual(password, c.env.API_KEY))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json<{ clientId?: unknown; clientName?: unknown }>().catch(() => null);
    if (!body || typeof body.clientId !== 'string' || typeof body.clientName !== 'string') {
      return c.json({ error: 'clientId and clientName are required' }, 400);
    }
    const clientId = body.clientId.trim();
    const clientName = body.clientName.trim();
    if (!clientId || !clientName) {
      return c.json({ error: 'clientId and clientName must be non-empty' }, 400);
    }

    const { token } = await registerClient(c.env.DB, clientId, clientName);
    return c.json({ clientId, token });
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
    c.executionCtx.waitUntil(bumpClientLastSeen(c.env.DB, client.id));

    const id = c.env.REALTIME.idFromName('singleton');
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
    c.executionCtx.waitUntil(bumpClientLastSeen(c.env.DB, client.id));
    await next();
  };

  app.use('/auth/check', requireAuth);
  app.use('/sync/*', requireAuth);

  app.get('/auth/check', (c) => c.json({ ok: true, client: { id: c.get('client').id } }));

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
