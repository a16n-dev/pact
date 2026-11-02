import { type Context, Hono } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import type { Env } from '../lib/env';
import { ApiError, badRequest } from '../lib/errors';
import { getApp } from '../db/apps';

export const aiRoutes = new Hono<AuthedEnv>();

aiRoutes.use('*', requireAuth);

aiRoutes.use('*', async (c, next) => {
  const app = await getApp(c.env.DB, c.get('token').app_id);
  if (app?.ai_proxy !== 1) {
    throw new ApiError(403, 'ai_disabled', 'AI is turned off for this app');
  }
  await next();
});

const MOUNT_PATH = '/ai';

// The Pact token must not reach the gateway, a client-supplied provider key would bypass
// Unified Billing, and client `cf-*` headers could override the gateway's own settings.
function isForwardedRequestHeader(name: string): boolean {
  return (
    !['authorization', 'x-api-key', 'cookie', 'host', 'origin'].includes(name) &&
    !name.startsWith('cf-')
  );
}

// CORS headers are the server's to set, and the runtime re-derives the framing headers for the
// body it sends.
function isForwardedResponseHeader(name: string): boolean {
  return (
    !['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name) &&
    !name.startsWith('access-control-')
  );
}

function gatewayConfig(env: Env): { account: string; gateway: string; token: string } {
  const { CLOUDFLARE_ACCOUNT_ID: account, AI_GATEWAY_ID: gateway, AI_GATEWAY_TOKEN: token } = env;
  if (!account || !gateway || !token) {
    throw new ApiError(503, 'ai_not_configured', 'This server has no AI Gateway configured');
  }
  return { account, gateway, token };
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

aiRoutes.post('/images', async (c) => {
  const body = await jsonObject(c.req.raw);
  const model = requiredString(body, 'model');
  const prompt = requiredString(body, 'prompt');
  const input: Record<string, unknown> = { prompt };
  for (const field of ['size', 'quality', 'background'] as const) {
    if (body[field] !== undefined) input[field] = requiredString(body, field);
  }
  const output = body.output === undefined ? null : outputOptions(body.output);
  const images = c.env.IMAGES;
  if (output && !images) {
    throw new ApiError(
      503,
      'ai_not_configured',
      'This server has no Images binding to convert with'
    );
  }

  const upstream = await runModel(c.env, c.get('token'), model, input);
  if (!upstream.ok) return passThrough(c, upstream);
  let image: Image;
  if (isImageType(upstream.headers.get('content-type'))) {
    image = await readImage(upstream);
  } else {
    const result = unwrapResult(await upstream.json().catch(() => null));
    const value = isObject(result) && typeof result.image === 'string' ? result.image : null;
    if (!value) throw new ApiError(502, 'ai_upstream_error', 'The model returned no image');
    image = await resolveImage(value);
  }
  if (!output || !images) {
    return c.body(image.bytes, 200, {
      'content-type': image.mimeType ?? sniffImageType(image.bytes),
    });
  }
  const converted = await convertImage(images, image.bytes, output);
  return c.body(converted.body, 200, { 'content-type': converted.contentType });
});

aiRoutes.post('/decide', async (c) => {
  const body = await jsonObject(c.req.raw);
  const model = requiredString(body, 'model');
  if (!isObject(body.questions)) throw badRequest('questions must be a JSON object');
  const upstream = await runModel(c.env, c.get('token'), model, {
    state: body.state ?? null,
    questions: body.questions,
  });
  if (!upstream.ok) return passThrough(c, upstream);
  const output = unwrapResult(await upstream.json().catch(() => null));
  if (!isObject(output) || !isObject(output.answers)) {
    throw new ApiError(502, 'ai_upstream_error', 'The model returned no answers');
  }
  return c.json({ answers: output.answers });
});

async function runModel(
  env: Env,
  pactToken: AuthedEnv['Variables']['token'],
  model: string,
  input: Record<string, unknown>
): Promise<Response> {
  const { gateway } = gatewayConfig(env);
  let upstream: Response;
  try {
    // The binding's types only know Workers AI's own model names, and don't model returnRawResponse.
    upstream = (await env.AI.run(model as never, input, {
      gateway: { id: gateway, metadata: { app: pactToken.app_id, token: pactToken.id } },
      returnRawResponse: true,
    })) as unknown as Response;
  } catch (error) {
    throw new ApiError(
      502,
      'ai_upstream_error',
      error instanceof Error ? error.message : 'AI request failed'
    );
  }
  if (upstream.status >= 500) {
    throw new ApiError(502, 'ai_upstream_error', `AI Gateway returned ${upstream.status}`);
  }
  return upstream;
}

function passThrough(c: Context<AuthedEnv>, upstream: Response): Response {
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    if (isForwardedResponseHeader(name)) responseHeaders[name] = value;
  }
  return c.newResponse(upstream.body, upstream.status as StatusCode, responseHeaders);
}

type Image = { bytes: Uint8Array<ArrayBuffer>; mimeType: string | null };

function imageTooLarge(): ApiError {
  return new ApiError(502, 'ai_upstream_error', 'The model returned an image over 20 MB');
}

function isImageType(contentType: string | null | undefined): contentType is string {
  return contentType?.startsWith('image/') ?? false;
}

// Models differ in what they return: a link to the gateway's output bucket, a data URI or bare
// base64. The link isn't readable from a browser, so the server fetches it.
async function resolveImage(value: string): Promise<Image> {
  if (value.startsWith('https://')) {
    let res: Response;
    try {
      res = await fetch(value);
    } catch (error) {
      throw new ApiError(
        502,
        'ai_upstream_error',
        error instanceof Error ? error.message : 'Fetching the image failed'
      );
    }
    if (!res.ok) {
      throw new ApiError(502, 'ai_upstream_error', `Fetching the image returned ${res.status}`);
    }
    return readImage(res);
  }
  const dataUri = /^data:([^;,]*)[^,]*;base64,/.exec(value);
  const base64 = dataUri ? value.slice(dataUri[0].length) : value;
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) throw imageTooLarge();
  try {
    return {
      bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
      mimeType: isImageType(dataUri?.[1]) ? dataUri[1] : null,
    };
  } catch {
    throw new ApiError(502, 'ai_upstream_error', 'The model returned an unreadable image');
  }
}

// Reads the body in chunks so an oversized image is refused before it fills the Worker's memory.
async function readImage(res: Response): Promise<Image> {
  const contentType = res.headers.get('content-type');
  const mimeType = isImageType(contentType) ? contentType : null;
  if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) throw imageTooLarge();
  if (!res.body) return { bytes: new Uint8Array(), mimeType };
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for await (const chunk of res.body) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > MAX_IMAGE_BYTES) throw imageTooLarge();
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType };
}

const OUTPUT_FORMATS = ['png', 'webp', 'jpeg', 'avif'] as const;
const OUTPUT_FITS = ['contain', 'cover', 'scale-down'] as const;
const MIN_OUTPUT_PX = 16;
const MAX_OUTPUT_PX = 2048;

type OutputOptions = {
  width?: number;
  height?: number;
  fit: (typeof OUTPUT_FITS)[number];
  format: (typeof OUTPUT_FORMATS)[number];
  quality?: number;
};

function outputOptions(value: unknown): OutputOptions {
  if (!isObject(value)) throw badRequest('output must be a JSON object');
  const format = oneOf(value.format, OUTPUT_FORMATS, 'output.format');
  const fit = value.fit === undefined ? 'contain' : oneOf(value.fit, OUTPUT_FITS, 'output.fit');
  const width = optionalInteger(value.width, 'output.width', MIN_OUTPUT_PX, MAX_OUTPUT_PX);
  const height = optionalInteger(value.height, 'output.height', MIN_OUTPUT_PX, MAX_OUTPUT_PX);
  const quality = optionalInteger(value.quality, 'output.quality', 1, 100);
  return { width, height, fit, format, quality };
}

async function convertImage(
  images: ImagesBinding,
  bytes: Uint8Array<ArrayBuffer>,
  { width, height, fit, format, quality }: OutputOptions
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  try {
    const result = await images
      .input(new Blob([bytes]).stream())
      .transform({ width, height, fit })
      .output({ format: `image/${format}`, quality });
    return { body: result.image(), contentType: result.contentType() };
  } catch (error) {
    throw new ApiError(
      502,
      'ai_upstream_error',
      error instanceof Error
        ? `Converting the image failed: ${error.message}`
        : 'Converting the image failed'
    );
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
  field: string
): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) {
    throw badRequest(`${field} must be one of ${options.join(', ')}`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function sniffImageType(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

// Workers AI's REST API wraps a model's output in `{ result }`; the binding's raw response may not.
function unwrapResult(body: unknown): unknown {
  return isObject(body) && 'result' in body ? body.result : body;
}

async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  if (!isObject(body)) throw badRequest('body must be a JSON object');
  return body;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value) throw badRequest(`${field} must be a non-empty string`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

aiRoutes.all('/*', async (c) => {
  const { account, gateway, token } = gatewayConfig(c.env);
  const pactToken = c.get('token');
  const url = new URL(c.req.url);
  const upstreamPath = url.pathname.slice(MOUNT_PATH.length);
  const upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}${upstreamPath}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers) {
    if (isForwardedRequestHeader(name)) headers.set(name, value);
  }
  headers.set('cf-aig-authorization', `Bearer ${token}`);
  headers.set('cf-aig-metadata', JSON.stringify({ app: pactToken.app_id, token: pactToken.id }));

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method: c.req.method, headers, body: c.req.raw.body });
  } catch (error) {
    throw new ApiError(
      502,
      'ai_upstream_error',
      error instanceof Error ? error.message : 'AI request failed'
    );
  }
  if (upstream.status >= 500) {
    throw new ApiError(502, 'ai_upstream_error', `AI Gateway returned ${upstream.status}`);
  }
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    if (isForwardedResponseHeader(name)) responseHeaders[name] = value;
  }
  return c.newResponse(upstream.body, upstream.status as StatusCode, responseHeaders);
});
