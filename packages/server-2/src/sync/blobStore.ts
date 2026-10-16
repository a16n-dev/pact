import { ApiError } from '../lib/errors';
import { sha256Hex } from '../lib/crypto';
import { LIMITS } from '../lib/limits';
import { recordBlob } from '../db/blobs';
import type { Env } from '../lib/env';
import type { TokenWithUser } from '../db/tokens';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

function blobTooLarge(): ApiError {
  return new ApiError(413, 'blob_too_large', 'A blob may be at most 50 MB');
}

// Buffers the request body, checks it against the declared hash and size limit, then writes it
// to R2 and records it in D1. Same hash, same bytes: a repeat upload keeps the first object and
// its content type.
export async function storeBlob(
  env: Env,
  token: TokenWithUser,
  hash: string,
  req: Request
): Promise<void> {
  if (Number(req.headers.get('content-length')) > LIMITS.blobBytes) throw blobTooLarge();
  const body = await req.arrayBuffer();
  if (body.byteLength > LIMITS.blobBytes) throw blobTooLarge();
  if ((await sha256Hex(body)) !== hash) {
    throw new ApiError(400, 'hash_mismatch', 'The body does not hash to the given hash');
  }
  const contentType = req.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE;
  const key = `${token.app_id}/${hash}`;
  if (!(await env.BLOBS.head(key))) {
    await env.BLOBS.put(key, body, { httpMetadata: { contentType } });
  }
  await recordBlob(env.DB, token.app_id, {
    hash,
    mime_type: contentType,
    size: body.byteLength,
    user_id: token.user_id,
    device_id: token.device_id,
  });
}

export async function readBlob(env: Env, appId: string, hash: string): Promise<Response> {
  const object = await env.BLOBS.get(`${appId}/${hash}`);
  if (!object) throw new ApiError(404, 'not_found', 'No blob with that hash');
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
      'content-length': String(object.size),
    },
  });
}
