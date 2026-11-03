import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import { ApiError, badRequest } from '../lib/errors';
import { getApp } from '../db/apps';
import { deleteApiCredentials, getApiCredentials, putApiCredentials } from '../db/apiCredentials';
import { readCapped } from '../lib/body';
import { seal, unseal } from './vault';

export const apiRoutes = new Hono<AuthedEnv>();

apiRoutes.use('*', requireAuth);

apiRoutes.use('*', async (c, next) => {
  const app = await getApp(c.env.DB, c.get('token').app_id);
  if (app?.api_proxy !== 1) {
    throw new ApiError(403, 'api_disabled', 'Third-party APIs are turned off for this app');
  }
  await next();
});

const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// The runtime owns the framing headers, and `cf-*` headers steer Cloudflare's own handling.
function isAllowedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    HEADER_NAME_RE.test(name) &&
    !['host', 'content-length', 'transfer-encoding', 'connection', 'cookie'].includes(lower) &&
    !lower.startsWith('cf-')
  );
}

const headerNameSchema = z
  .string()
  .max(128)
  .refine(isAllowedHeaderName, 'is not a header name the server will send');
const headerValueSchema = z
  .string()
  .max(8192)
  .refine((value) => !/[\r\n\0]/.test(value), 'contains a line break');

const baseUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return !url.search && !url.hash && !url.username && !url.password;
  }, 'must be an https URL without a query, fragment or user info');

const placementSchema = z.discriminatedUnion('in', [
  z.object({
    in: z.literal('header'),
    name: headerNameSchema,
    prefix: z.string().max(64).optional(),
  }),
  z.object({ in: z.literal('query'), name: z.string().min(1).max(128) }),
]);

const credentialSchema = z.intersection(
  placementSchema,
  z.object({ value: headerValueSchema.pipe(z.string().min(1)) })
);

type Credential = z.infer<typeof credentialSchema>;

const putBodySchema = z.object({
  baseUrl: baseUrlSchema,
  credentials: z
    .record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), credentialSchema)
    .refine((fields) => {
      const count = Object.keys(fields).length;
      return count > 0 && count <= 16;
    }, 'must have 1 to 16 fields'),
});

const callBodySchema = z.object({
  baseUrl: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z
    .string()
    .max(4096)
    .regex(/^\/[^?#]*$/, 'must start with / and have no query or fragment'),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(headerNameSchema, headerValueSchema).optional(),
  body: z.json().optional(),
});

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

function apiName(raw: string): string {
  const parsed = nameSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('API name must be 1–64 letters, digits, `_`, `.` or `-`');
  return parsed.data;
}

function sealContext(appId: string, name: string): string {
  return `${appId}/${name}`;
}

apiRoutes.get('/:name/credentials', async (c) => {
  const name = apiName(c.req.param('name'));
  const row = await getApiCredentials(c.env.DB, c.get('token').app_id, name);
  if (!row) throw new ApiError(404, 'not_found', `No credentials are set for ${name}`);
  return c.json({
    baseUrl: row.base_url,
    fields: JSON.parse(row.fields) as string[],
    updatedAt: row.updated_at,
  });
});

apiRoutes.put('/:name/credentials', async (c) => {
  const name = apiName(c.req.param('name'));
  const appId = c.get('token').app_id;
  const { baseUrl, credentials } = await parseBody(c.req.raw, putBodySchema);
  await putApiCredentials(c.env.DB, appId, name, {
    base_url: baseUrl,
    fields: JSON.stringify(Object.keys(credentials).sort()),
    sealed: await seal(c.env, sealContext(appId, name), JSON.stringify(credentials)),
    updated_at: Date.now(),
  });
  return c.body(null, 204);
});

apiRoutes.delete('/:name/credentials', async (c) => {
  const name = apiName(c.req.param('name'));
  await deleteApiCredentials(c.env.DB, c.get('token').app_id, name);
  return c.body(null, 204);
});

apiRoutes.post('/:name/call', async (c) => {
  const name = apiName(c.req.param('name'));
  const appId = c.get('token').app_id;
  const call = await parseBody(c.req.raw, callBodySchema);
  const row = await getApiCredentials(c.env.DB, appId, name);
  if (!row) throw new ApiError(404, 'not_found', `No credentials are set for ${name}`);
  if (call.baseUrl !== row.base_url) {
    throw new ApiError(
      409,
      'api_base_url_changed',
      `The credentials for ${name} were saved for ${row.base_url}; set them again for ${call.baseUrl}`
    );
  }
  if (call.body !== undefined && call.method === 'GET') {
    throw badRequest('A GET request cannot have a body');
  }

  const url = upstreamUrl(row.base_url, call.path);
  for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.append(key, value);
  const headers = new Headers(call.headers);
  if (call.body !== undefined) headers.set('content-type', 'application/json');
  const credentials = JSON.parse(
    await unseal(c.env, sealContext(appId, name), row.sealed)
  ) as Record<string, Credential>;
  for (const credential of Object.values(credentials)) {
    if (credential.in === 'header') {
      headers.set(credential.name, `${credential.prefix ?? ''}${credential.value}`);
    } else {
      url.searchParams.set(credential.name, credential.value);
    }
  }

  let upstream: Response;
  try {
    // Redirects are returned rather than followed, so credentials never reach a host other than
    // the one they were saved for.
    upstream = await fetch(url, {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(
      502,
      'api_upstream_error',
      error instanceof Error ? error.message : `${name} request failed`
    );
  }
  const body = await readCapped(upstream, MAX_RESPONSE_BYTES);
  if (!body)
    throw new ApiError(502, 'api_upstream_error', `${name} returned a response over 10 MB`);
  // The upstream status rides in a header so a 401 from the API can't read as the Pact token
  // being rejected.
  c.header('access-control-expose-headers', 'pact-upstream-status');
  return c.body(body, 200, {
    'pact-upstream-status': String(upstream.status),
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
  });
});

// `path` is resolved against the base and must stay under it, so `..` segments can't reach
// another path on the host.
function upstreamUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const url = new URL(`${base.origin}${basePath}${path}`);
  if (url.origin !== base.origin || !`${url.pathname}/`.startsWith(`${basePath}/`)) {
    throw badRequest('path must stay under the base URL');
  }
  return url;
}
