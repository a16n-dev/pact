import type { Context } from 'hono';
import { pushDocuments, pullDocument, pullDocumentsSince } from './api';
import type { Env, PushRequest, PullResponse } from '../types';
import type { ClientRow } from '../auth/auth';

// These handlers run behind `requireAuth`, which stores the authenticated
// client row; its `appName` (recorded at registration, never client-supplied)
// is the tenant scope for every operation here.
type HonoEnv = { Bindings: Env; Variables: { client: ClientRow } };

function appOf(c: Context<HonoEnv>): { appName: string; clientId: string } {
  const client = c.get('client');
  return { appName: client.appName, clientId: client.id };
}

export async function handlePush(c: Context<HonoEnv>) {
  const body = await c.req.json<PushRequest>();
  const outcome = await pushDocuments(c.env, appOf(c), body.documents, {
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  if (!outcome.ok) {
    return c.json({ error: outcome.error, code: outcome.code }, outcome.status as 400);
  }
  return c.json(outcome.result);
}

// Two modes: `?cursor=` pages the whole app's rows after a seq;
// `?collection=&id=` returns one document's sibling rows.
export async function handlePull(c: Context<HonoEnv>) {
  const collection = c.req.query('collection');
  const id = c.req.query('id');
  const cursorRaw = c.req.query('cursor');

  if (id) {
    if (!collection) return c.json({ error: 'collection is required with id' }, 400);
    // All of the document's sibling rows; the client folds them.
    const documents = await pullDocument(c.env, appOf(c), collection, id);
    return c.json({ documents, cursor: 0, hasMore: false } satisfies PullResponse);
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
  } = await pullDocumentsSince(c.env, appOf(c), cursor);
  return c.json({ documents, cursor: nextCursor, hasMore } satisfies PullResponse);
}
