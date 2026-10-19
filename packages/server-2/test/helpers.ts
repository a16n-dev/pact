import { env, SELF } from 'cloudflare:test';
import { createApp, addRedirectUri, setAllowLocalhost } from '../src/db/apps';
import { createUser } from '../src/db/users';
import { mintApiToken } from '../src/db/tokens';
import { base64url } from '../src/lib/crypto';

export const ORIGIN = 'https://sync.example.test';

export async function seedApp(
  id = 'app-a',
  redirectUris: string[] = ['https://app.example.test/callback'],
  allowLocalhost = true
): Promise<{ id: string; token: string; tokenId: string }> {
  await createApp(env.DB, id, `App ${id}`);
  for (const uri of redirectUris) await addRedirectUri(env.DB, id, uri);
  await setAllowLocalhost(env.DB, id, allowLocalhost);
  const { token, id: tokenId } = await mintApiToken(env.DB, id, 'test script');
  return { id, token, tokenId };
}

export async function seedUser(username = 'alex', password = 'correcthorse'): Promise<void> {
  await createUser(env.DB, username, password);
}

export function api(
  path: string,
  token: string | null,
  init: RequestInit & { json?: unknown } = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers, body });
}

export async function push(token: string, documents: unknown[]): Promise<Response> {
  return api('/sync/push', token, { method: 'POST', json: { documents } });
}

export function doc(
  id: string,
  data: string,
  collection = 'notes',
  hlc = '1'
): Record<string, string> {
  return { collection, id, hlc, data };
}

export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
