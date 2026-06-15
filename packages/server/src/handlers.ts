import type { Context } from 'hono';
import { pushDocuments, pullDocument, pullDocumentsSince, type SyncHooks } from './api';
import type { Env, PushRequest, PullResponse } from './types';

type HonoEnv = { Bindings: Env };

export function makePushHandler(hooks?: SyncHooks) {
  return async (c: Context<HonoEnv>) => {
    const body = await c.req.json<PushRequest>();
    const outcome = await pushDocuments(c.env, body.documents, {
      hooks,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    if (!outcome.ok) {
      return c.json({ error: outcome.error, code: outcome.code }, outcome.status as 400);
    }
    return c.json(outcome.result);
  };
}

export async function handlePull(c: Context<HonoEnv>) {
  const collection = c.req.query('collection');
  const id = c.req.query('id');
  const cursorRaw = c.req.query('cursor');

  if (!collection) return c.json({ error: 'collection is required' }, 400);

  if (id) {
    const doc = await pullDocument(c.env, collection, id);
    return c.json({
      documents: doc ? [doc] : [],
      cursor: 0,
      hasMore: false,
    } satisfies PullResponse);
  }

  if (cursorRaw === undefined) return c.json({ error: 'cursor is required' }, 400);
  const cursor = Number(cursorRaw);
  if (!Number.isInteger(cursor) || cursor < 0) {
    return c.json({ error: 'cursor must be a non-negative integer' }, 400);
  }

  const {
    documents,
    cursor: nextCursor,
    hasMore,
  } = await pullDocumentsSince(c.env, collection, cursor);
  return c.json({ documents, cursor: nextCursor, hasMore } satisfies PullResponse);
}
