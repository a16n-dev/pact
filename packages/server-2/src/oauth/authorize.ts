import { z } from 'zod';
import type { Env } from '../lib/env';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../lib/crypto';
import { appIdSchema, deviceIdSchema, labelSchema, usernameSchema } from '../lib/validation';
import { getUserByUsername, type UserRow } from '../db/users';
import { isAllowedRedirectUriForm } from '../auth/redirectUris';
import { verifyTurnstile } from './turnstile';

// The query string the app opens the login page with. Only S256 PKCE is accepted.
const authorizeParamsSchema = z.object({
  app_id: appIdSchema,
  redirect_uri: z.string().refine(isAllowedRedirectUriForm),
  device_id: deviceIdSchema,
  device_name: labelSchema,
  state: z.string().min(1).max(512),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
});

export type AuthorizeParams = z.infer<typeof authorizeParamsSchema>;

export function parseAuthorizeParams(query: Record<string, string>): AuthorizeParams | null {
  const parsed = authorizeParamsSchema.safeParse(query);
  return parsed.success ? parsed.data : null;
}

// Form fields may be missing or files; anything unusable becomes an empty value and fails the
// sign-in rather than the request.
const loginFormSchema = z.object({
  username: z.string().trim().catch(''),
  password: z.string().catch(''),
  'cf-turnstile-response': z.string().optional().catch(undefined),
});

export type LoginForm = z.infer<typeof loginFormSchema>;

export function parseLoginForm(form: unknown): LoginForm {
  return loginFormSchema.parse(form);
}

export const CREDENTIALS_ERROR = 'Username or password is incorrect.';

export type SignInResult = { user: UserRow } | { error: string; status: 401 | 429 };

// Rate limit, then Turnstile, then credentials. An unknown username costs the same password
// derivation as a wrong password so timing reveals nothing.
export async function signIn(
  env: Env,
  form: LoginForm,
  ip: string | undefined
): Promise<SignInResult> {
  const [byIp, byUser] = await Promise.all([
    env.LOGIN_LIMITER.limit({ key: `ip:${ip ?? 'unknown'}` }),
    env.LOGIN_LIMITER.limit({ key: `user:${form.username}` }),
  ]);
  if (!byIp.success || !byUser.success) {
    return { error: 'Too many sign-in attempts. Wait a minute, then try again.', status: 429 };
  }
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, form['cf-turnstile-response'], ip))) {
    return { error: "We couldn't confirm you're human. Try signing in again.", status: 401 };
  }
  const user = usernameSchema.safeParse(form.username).success
    ? await getUserByUsername(env.DB, form.username)
    : null;
  const passwordOk = await verifyPassword(
    form.password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH
  );
  if (!user || !passwordOk) return { error: CREDENTIALS_ERROR, status: 401 };
  return { user };
}
