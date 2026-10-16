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

// Every sync API takes one, making app scoping a compile-time obligation.
// HTTP handlers build it from the authenticated client row.
export interface AppContext {
  appName: string;
}

export interface SyncHooks {
  /**
   * Upgrades each pushed document's data to the server's schema before it is
   * stored. Throw to reject the whole push.
   */
  migrate?: (collection: string, data: unknown) => unknown;
}

// Author id clients use before they have a server identity. Part of the sync
// protocol, so it lives here rather than in the client package.
const LOCAL_AUTHOR_ID = '_local';

interface PushResult {
  accepted: number;
  // Writes the last-write-wins guard declined because the stored copy was
  // newer-or-equal.
  skipped: number;
}

export type PushOutcome =
  | { ok: true; result: PushResult }
  | { ok: false; status: number; error: string; code: string };

export interface PushOptions {
  hooks?: SyncHooks;
  // Required for realtime: accepted writes broadcast a collection
  // invalidation only when this is supplied and REALTIME is enabled.
  waitUntil?: (p: Promise<unknown>) => void;
}

export async function pushDocuments(
  env: Env,
  app: AppContext,
  docs: SyncDocument[],
  opts: PushOptions = {}
): Promise<PushOutcome> {
  if (!Array.isArray(docs)) {
    return { ok: false, status: 400, error: 'documents must be an array', code: 'bad_request' };
  }

  // A local-author doc means the client pushed before reassigning to a real
  // identity, an ordering bug on its side. Reject the whole batch so a push
  // either fully succeeds or fully fails; name offenders for debugging.
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
    // One DO per app: its socket set only holds this app's clients, so a
    // broadcast cannot cross tenants.
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

// Operator-only; intentionally not exposed over HTTP (see createSyncApp).
export async function wipeAllDocumentsViaApi(env: Env, app: AppContext): Promise<void> {
  await wipeAllDocuments(env.DB, app.appName);
}

// Bytes are namespaced per app rather than deduped across tenants: a shared
// key would let one app read or existence-probe another's blobs. The app
// name charset guarantees the prefix cannot escape into another keyspace.
function blobKey(app: AppContext, hash: string): string {
  return `${app.appName}/${hash}`;
}

// Operator-only; intentionally not exposed over HTTP (see createSyncApp).
// Scans the bucket rather than the table so objects the table never recorded
// are cleared too. Bytes go first: a partial failure leaves orphan rows that
// self-heal as 404s on the next pull.
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
  // R2 returns null only for a failed conditional put, which this
  // unconditional put cannot hit; the fallbacks exist to satisfy the type.
  const size = obj?.size ?? (body instanceof ArrayBuffer ? body.byteLength : 0);
  const createdAt = obj?.uploaded?.toISOString() ?? dayjs().toISOString();
  await upsertBlob(env.DB, app.appName, { hash, mimeType: contentType, size, createdAt });
}

export async function listBlobs(env: Env, app: AppContext): Promise<string[]> {
  return listBlobHashes(env.DB, app.appName);
}
