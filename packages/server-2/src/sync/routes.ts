import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import { maxPushDocuments } from '../lib/env';
import { ApiError, badRequest } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import {
  currentSeq,
  pullDocument,
  pullDocumentVersions,
  pushDocumentVersions,
  type PushedDocumentVersion,
} from '../db/documents';
import { listBlobHashes, recordBlob } from '../db/blobs';
import { notifyRealtime } from '../realtime';
import { sha256Hex } from '../lib/crypto';

const HASH_RE = /^[0-9a-f]{64}$/;

const pushedVersionSchema = z.object({
  collection: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
  hlc: z.string().min(1).max(64),
  data: z.string().min(1),
});
const pushBodySchema = z.object({ documents: z.array(pushedVersionSchema) });

function parsePushBody(body: unknown, maxDocuments: number): PushedDocumentVersion[] {
  const count = (body as { documents?: unknown[] } | null)?.documents?.length ?? 0;
  if (count > maxDocuments) {
    throw new ApiError(
      413,
      'too_many_documents',
      `A push may hold at most ${maxDocuments} documents`
    );
  }
  const parsed = pushBodySchema.safeParse(body);
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  for (const version of parsed.data.documents) {
    if (new TextEncoder().encode(version.data).byteLength > LIMITS.dataBytes) {
      throw new ApiError(413, 'document_too_large', 'A document may hold at most 1 MB of data');
    }
  }
  return parsed.data.documents;
}

export const syncRoutes = new Hono<AuthedEnv>();

syncRoutes.use('*', requireAuth);

syncRoutes.post('/push', async (c) => {
  const body = await c.req.json().catch(() => null);
  const documents = parsePushBody(body, maxPushDocuments(c.env));
  const token = c.get('token');
  if (documents.length === 0) return c.json({ seq: await currentSeq(c.env.DB, token.app_id) });
  const seq = await pushDocumentVersions(c.env.DB, token.app_id, token.id, documents);
  c.executionCtx.waitUntil(notifyRealtime(c.env, token.app_id, (rt) => rt.broadcast(seq)));
  return c.json({ seq });
});

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
  const cursorRaw = c.req.query('cursor');
  const cursor = Number(cursorRaw);
  if (cursorRaw === undefined || !Number.isInteger(cursor) || cursor < 0) {
    throw badRequest('cursor must be a non-negative integer');
  }
  const page = await pullDocumentVersions(c.env.DB, appId, cursor, collections);
  return c.json({ documents: page.versions, cursor: page.cursor, hasMore: page.hasMore });
});

syncRoutes.get('/blobs', async (c) => {
  return c.json({ hashes: await listBlobHashes(c.env.DB, c.get('token').app_id) });
});

syncRoutes.put('/blobs/:hash', async (c) => {
  const hash = c.req.param('hash');
  if (!HASH_RE.test(hash)) throw badRequest('hash must be a lowercase SHA-256 hex digest');
  const declaredLength = Number(c.req.header('content-length'));
  if (declaredLength > LIMITS.blobBytes) throw blobTooLarge();
  const body = await c.req.arrayBuffer();
  if (body.byteLength > LIMITS.blobBytes) throw blobTooLarge();
  if ((await sha256Hex(body)) !== hash) {
    throw new ApiError(400, 'hash_mismatch', 'The body does not hash to the given hash');
  }
  const token = c.get('token');
  const appId = token.app_id;
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  const key = `${appId}/${hash}`;
  // Same hash, same bytes: a repeat upload keeps the first object and its content type.
  if (!(await c.env.BLOBS.head(key))) {
    await c.env.BLOBS.put(key, body, { httpMetadata: { contentType } });
  }
  await recordBlob(c.env.DB, appId, {
    hash,
    mime_type: contentType,
    size: body.byteLength,
    user_id: token.user_id,
    device_id: token.device_id,
  });
  return c.body(null, 204);
});

syncRoutes.get('/blobs/:hash', async (c) => {
  const hash = c.req.param('hash');
  if (!HASH_RE.test(hash)) throw badRequest('hash must be a lowercase SHA-256 hex digest');
  const object = await c.env.BLOBS.get(`${c.get('token').app_id}/${hash}`);
  if (!object) throw new ApiError(404, 'not_found', 'No blob with that hash');
  return c.body(object.body, 200, {
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-length': String(object.size),
  });
});

function blobTooLarge(): ApiError {
  return new ApiError(413, 'blob_too_large', 'A blob may be at most 50 MB');
}
