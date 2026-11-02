import { Hono } from 'hono';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import { maxPushDocuments } from '../lib/env';
import { badRequest } from '../lib/errors';
import {
  currentSeq,
  pullDocument,
  pullDocumentVersions,
  pushDocumentVersions,
} from '../db/documents';
import { listBlobHashes } from '../db/blobs';
import { notifyRealtime } from '../realtime/durableObject';
import { parseCursor, parseHash, parsePushBody } from './validation';
import { readBlob, storeBlob } from './blobStore';

export const syncRoutes = new Hono<AuthedEnv>();

syncRoutes.use('*', requireAuth);

syncRoutes.post('/push', async (c) => {
  const body = await c.req.json().catch(() => null);
  const versions = parsePushBody(body, maxPushDocuments(c.env));
  const token = c.get('token');
  if (versions.length === 0) return c.json({ seq: await currentSeq(c.env.DB, token.app_id) });
  const seq = await pushDocumentVersions(c.env.DB, token.app_id, token.id, versions);
  c.executionCtx.waitUntil(notifyRealtime(c.env, token.app_id, (rt) => rt.broadcast(seq)));
  return c.json({ seq });
});

// Without `id`: every version after `cursor`. With `id` and one `collection`: every version of
// that document.
syncRoutes.get('/pull', async (c) => {
  const appId = c.get('token').app_id;
  const id = c.req.query('id');
  const collections = c.req.queries('collection') ?? [];
  if (id !== undefined) {
    const [collection] = collections;
    if (collections.length !== 1 || !collection) {
      throw badRequest('pulling one document takes exactly one collection');
    }
    const documents = await pullDocument(c.env.DB, appId, collection, id);
    return c.json({ documents, cursor: documents.at(-1)?.seq ?? 0, hasMore: false });
  }
  const cursor = parseCursor(c.req.query('cursor'));
  const page = await pullDocumentVersions(c.env.DB, appId, cursor, collections);
  return c.json({ documents: page.versions, cursor: page.cursor, hasMore: page.hasMore });
});

syncRoutes.get('/blobs', async (c) => {
  return c.json({ hashes: await listBlobHashes(c.env.DB, c.get('token').app_id) });
});

syncRoutes.put('/blobs/:hash', async (c) => {
  await storeBlob(c.env, c.get('token'), parseHash(c.req.param('hash')), c.req.raw);
  return c.body(null, 204);
});

syncRoutes.get('/blobs/:hash', async (c) => {
  return readBlob(c.env, c.get('token').app_id, parseHash(c.req.param('hash')));
});
