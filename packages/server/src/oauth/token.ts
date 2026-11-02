import { z } from 'zod';
import type { HonoRequest } from 'hono';
import { sha256Base64url } from '../lib/crypto';
import { appIdSchema } from '../lib/validation';
import { consumeAuthCode } from '../db/authCodes';
import { issueDeviceToken } from '../db/tokens';

export type OAuthError = 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type';

// The token endpoint takes JSON or a form body, as OAuth clients vary.
export async function readTokenBody(req: HonoRequest): Promise<Record<string, unknown> | null> {
  const contentType = req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await req.json().catch(() => null)) as Record<string, unknown> | null;
  }
  return req.parseBody().catch(() => null) as Promise<Record<string, unknown> | null>;
}

const tokenRequestSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string(),
  app_id: appIdSchema,
});

export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export function parseTokenRequest(body: Record<string, unknown>): TokenRequest | null {
  const parsed = tokenRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

// Consumes the code and, if it matches the request and the PKCE verifier, issues the device's
// token. Returns null when the grant is invalid for any reason.
export async function redeemAuthCode(
  db: D1Database,
  request: TokenRequest
): Promise<string | null> {
  const grant = await consumeAuthCode(db, request.code);
  if (
    !grant ||
    grant.app_id !== request.app_id ||
    grant.redirect_uri !== request.redirect_uri ||
    grant.code_challenge !== (await sha256Base64url(request.code_verifier))
  ) {
    return null;
  }
  return issueDeviceToken(db, grant.app_id, grant.user_id, grant.device_id, grant.device_name);
}
