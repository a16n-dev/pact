import dayjs from 'dayjs';
import {
  upsertDocuments,
  getDocumentById,
  getDocumentsSince,
  wipeAllDocuments,
  upsertBlob,
  listBlobHashes,
  wipeAllBlobRecords,
} from './db';
import type { Env, SyncDocument } from '../types';

/**
 * The tenant a call operates on behalf of. Every programmatic sync API takes
 * one, so app scoping is a compile-time obligation rather than a convention.
 * HTTP handlers build it from the authenticated client row; in-Worker callers
 * pass the app they act for.
 */
export interface AppContext {
  appName: string;
}

export interface SyncHooks {
  /**
   * Transform a stored doc to the server's current schemaVersion before
   * persisting. Called once per document on the push path. Throw to reject
   * the push (e.g. the client is newer than this server's schema).
   */
  migrate?: (collection: string, data: unknown) => unknown;
}

/**
 * Sentinel author id used by clients pre-identification. The sync server
 * rejects any pushed doc still tagged with it — the client must reassign to
 * a real author before sync. The convention is part of the sync protocol, so
 * it lives here rather than in the consuming package.
 */
const LOCAL_AUTHOR_ID = '_local';

export interface PushResult {
  /** Docs inserted or updated. */
  accepted: number;
  /** Docs the last-write-wins guard skipped (stored copy newer-or-equal). */
  skipped: number;
}

export type PushOutcome =
  | { ok: true; result: PushResult }
  | { ok: false; status: number; error: string; code: string };

export interface PushOptions {
  hooks?: SyncHooks;
  /**
   * If supplied alongside an enabled REALTIME binding, accepted writes
   * broadcast a collection invalidation to connected websocket clients.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * Programmatic equivalent of `POST /sync/push`. The HTTP handler is a thin
 * shell over this; in-Worker callers can write the same way without an HTTP
 * round trip.
 */
export async function pushDocuments(
  env: Env,
  app: AppContext,
  docs: SyncDocument[],
  opts: PushOptions = {}
): Promise<PushOutcome> {
  if (!Array.isArray(docs)) {
    return { ok: false, status: 400, error: 'documents must be an array', code: 'bad_request' };
  }

  // A doc still tagged with the local-author sentinel means the client pushed
  // before claiming/reassigning a real identity — a client-side ordering bug,
  // not a routine condition (the claim flow reassigns local docs before any
  // push). Reject the whole batch atomically: a push fully succeeds or fully
  // fails, which is simpler for clients to reason about than a partial accept
  // that would silently strip these docs. Name the offenders so it's
  // debuggable if it ever fires.
  const offenders = docs
    .filter((d) => {
      const data = d.data as
        | { createdBy?: unknown; updatedBy?: unknown; deletedBy?: unknown }
        | null
        | undefined;
      if (!data || typeof data !== 'object') return false;
      return (
        data.createdBy === LOCAL_AUTHOR_ID ||
        data.updatedBy === LOCAL_AUTHOR_ID ||
        data.deletedBy === LOCAL_AUTHOR_ID
      );
    })
    .map((d) => `${d.collection}/${d.id}`);
  if (offenders.length > 0) {
    const sample = offenders.slice(0, 5).join(', ');
    const more = offenders.length > 5 ? `, +${offenders.length - 5} more` : '';
    return {
      ok: false,
      status: 400,
      error:
        `Cannot push ${offenders.length} document(s) authored by the local author (${sample}${more}). ` +
        'Claim or create a server identity and reassign local docs before pushing.',
      code: 'local_author_push_rejected',
    };
  }

  let upgraded: SyncDocument[];
  try {
    const migrate = opts.hooks?.migrate;
    upgraded = migrate ? docs.map((d) => ({ ...d, data: migrate(d.collection, d.data) })) : docs;
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Migration failed',
      code: 'migration_failed',
    };
  }

  const result = await upsertDocuments(env.DB, app.appName, upgraded);

  if (env.ENABLE_REALTIME === 'true' && result.accepted > 0 && opts.waitUntil) {
    const collections = [...new Set(upgraded.map((d) => d.collection))];
    // One Durable Object per app: the DO's socket set only ever contains this
    // app's clients, so cross-tenant broadcast is impossible by construction.
    const stub = env.REALTIME.get(env.REALTIME.idFromName(app.appName));
    opts.waitUntil(Promise.resolve(stub.broadcast(collections)));
  }

  return { ok: true, result };
}

export async function pullDocument(
  env: Env,
  app: AppContext,
  collection: string,
  id: string
): Promise<SyncDocument | null> {
  return getDocumentById(env.DB, app.appName, collection, id);
}

export async function pullDocumentsSince(
  env: Env,
  app: AppContext,
  collection: string,
  cursor: number
): Promise<{ documents: SyncDocument[]; cursor: number; hasMore: boolean }> {
  return getDocumentsSince(env.DB, app.appName, collection, cursor);
}

export async function wipeAllDocumentsViaApi(env: Env, app: AppContext): Promise<void> {
  await wipeAllDocuments(env.DB, app.appName);
}

/**
 * R2 object key for a blob. Bytes are namespaced per app: content-addressing
 * would happily dedupe identical bytes across tenants, but a shared key would
 * let one app read (or existence-probe) another's blobs — so each app pays
 * for its own copy. App names are charset-validated at registration, so the
 * prefix can't collide with or escape into another app's keyspace.
 */
function blobKey(app: AppContext, hash: string): string {
  return `${app.appName}/${hash}`;
}

/**
 * Delete every blob owned by `app`: both the R2 bytes and the registry rows.
 * Scans the bucket directly (not the table) so drift — objects R2 holds but
 * the table never recorded — gets cleared too. Bytes go first; a partial
 * failure leaves orphan rows that self-heal as 404s on the next pull. The
 * prefix confines both the listing and the deletes to this app's keyspace.
 */
export async function wipeAllBlobsViaApi(env: Env, app: AppContext): Promise<void> {
  const prefix = `${app.appName}/`;
  let cursor: string | undefined;
  do {
    const page = await env.BLOBS.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await env.BLOBS.delete(page.objects.map((o) => o.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await wipeAllBlobRecords(env.DB, app.appName);
}

export async function getBlob(
  env: Env,
  app: AppContext,
  hash: string
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const obj = await env.BLOBS.get(blobKey(app, hash));
  if (!obj) return null;
  return {
    body: obj.body,
    contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
  };
}

export async function putBlob(
  env: Env,
  app: AppContext,
  hash: string,
  body: ArrayBuffer | ReadableStream,
  contentType: string
): Promise<void> {
  const obj = await env.BLOBS.put(blobKey(app, hash), body, { httpMetadata: { contentType } });
  // R2 reports the stored size/time authoritatively; fall back only for the
  // null-result edge (conditional puts) which this unconditional path won't hit.
  const size = obj?.size ?? (body instanceof ArrayBuffer ? body.byteLength : 0);
  const createdAt = obj?.uploaded?.toISOString() ?? dayjs().toISOString();
  await upsertBlob(env.DB, app.appName, { hash, mimeType: contentType, size, createdAt });
}

export async function listBlobs(env: Env, app: AppContext): Promise<string[]> {
  return listBlobHashes(env.DB, app.appName);
}
