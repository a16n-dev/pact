import type { Context } from 'hono';
import { getBlob, listBlobs, putBlob } from './api';
import type { Env } from '../types';

type HonoEnv = { Bindings: Env };

/**
 * Content-addressed blob storage. Bytes are keyed by their SHA-256 hex
 * digest, so the bucket is effectively a CAS — duplicate puts collapse,
 * and `GET /sync/blobs` returns the authoritative set of stored hashes
 * for clients to diff against their local cache.
 */

export async function handleBlobPut(c: Context<HonoEnv>) {
  const hash = c.req.param('hash')!;
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  const body = await c.req.arrayBuffer();
  // Content-addressing is the whole integrity model (dedupe, idempotency,
  // "same hash ⇒ same bytes"). Verify it server-side rather than trusting the
  // client's key, so a buggy or hostile client can't store wrong bytes under a
  // hash other documents reference.
  const actual = await sha256Hex(body);
  if (actual !== hash) {
    return c.json({ error: 'blob hash does not match content', code: 'hash_mismatch' }, 400);
  }
  await putBlob(c.env, hash, body, contentType);
  return c.body(null, 204);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleBlobGet(c: Context<HonoEnv>) {
  const hash = c.req.param('hash')!;
  const blob = await getBlob(c.env, hash);
  if (!blob) return c.body(null, 404);
  return c.body(blob.body, 200, { 'content-type': blob.contentType });
}

export async function handleBlobList(c: Context<HonoEnv>) {
  const hashes = await listBlobs(c.env);
  return c.json({ hashes });
}
