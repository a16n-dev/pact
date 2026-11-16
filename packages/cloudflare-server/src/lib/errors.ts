import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

type ErrorCode =
  | 'bad_request'
  | 'hash_mismatch'
  | 'unauthorized'
  | 'origin_not_allowed'
  | 'not_found'
  | 'too_many_documents'
  | 'document_too_large'
  | 'blob_too_large'
  | 'ai_upstream_error'
  | 'ai_not_configured'
  | 'ai_disabled'
  | 'api_upstream_error'
  | 'api_not_configured'
  | 'api_disabled'
  | 'api_base_url_changed';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'bad_request', message);
}

export function errorResponse(c: Context, error: ApiError): Response {
  return c.json({ error: error.message, code: error.code }, error.status);
}
