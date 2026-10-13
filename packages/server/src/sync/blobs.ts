import type { Context } from 'hono';
import { getBlob, listBlobs, putBlob } from './api';
import type { Env } from '../types';
import type { ClientRow } from '../auth/auth';

type HonoEnv = { Bindings: Env; Variables: { client: ClientRow } };

function appOf(c: Context<HonoEnv>): { appName: string } {
  return { appName: c.get('client').appName };
}

export async function handleBlobPut(c: Context<HonoEnv>) {
  const hash = c.req.param('hash')!;
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  const body = await c.req.arrayBuffer();
  // Content-addressing is the integrity model: a client must not be able to
  // store other bytes under a hash that documents already reference.
  const actual = await sha256Hex(body);
  if (actual !== hash) {
    return c.json({ error: 'blob hash does not match content', code: 'hash_mismatch' }, 400);
  }
  await putBlob(c.env, appOf(c), hash, body, contentType);
  return c.body(null, 204);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleBlobGet(c: Context<HonoEnv>) {
  const hash = c.req.param('hash')!;
  const blob = await getBlob(c.env, appOf(c), hash);
  if (!blob) return c.body(null, 404);
  return c.body(blob.body, 200, { 'content-type': blob.contentType });
}

export async function handleBlobList(c: Context<HonoEnv>) {
  const hashes = await listBlobs(c.env, appOf(c));
  return c.json({ hashes });
}
