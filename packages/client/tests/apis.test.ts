import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { createApis, ApiResponseError } from '../src/apis/apis';
import { apiMethod, defineApi } from '../src/apis/api';
import { SyncError, UnauthorizedError } from '../src/sync/http';

const CREDS = { url: 'https://pact.test', token: 'pact_t' };

const weather = defineApi({
  name: 'weather',
  baseUrl: 'https://api.weather.test/v2',
  credentials: {
    apiKey: { schema: z.string().min(10), in: 'header', name: 'Authorization', prefix: 'Bearer ' },
    project: { schema: z.string(), in: 'query', name: 'project' },
  },
  methods: {
    forecast: apiMethod({
      request: z.object({ city: z.string(), days: z.number().optional() }),
      response: z.object({ high: z.number() }),
      build: ({ city, days }) => ({ path: `/forecast/${city}`, query: { days } }),
    }),
    ping: apiMethod({
      request: z.object({}),
      response: z.undefined(),
      build: () => ({ method: 'POST', path: '/ping', body: { at: 1 } }),
    }),
  },
});

function stubFetch(respond: (req: Request) => Response): Request[] {
  const calls: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    return respond(req);
  });
  return calls;
}

function upstream(body: BodyInit | null, status = 200, contentType = 'application/json') {
  return new Response(body, {
    headers: { 'pact-upstream-status': String(status), 'content-type': contentType },
  });
}

function signedIn(onUnauthorized = () => {}) {
  return createApis({ credentials: async () => CREDS, onUnauthorized });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defineApi', () => {
  it('types each method build from its request schema', () => {
    expectTypeOf(weather.methods.forecast.build)
      .parameter(0)
      .toEqualTypeOf<{ city: string; days?: number | undefined }>();
  });

  it('rejects a base URL that is not https', () => {
    expect(() =>
      defineApi({
        name: 'x',
        baseUrl: 'http://x.test',
        credentials: weather.credentials,
        methods: {},
      })
    ).toThrow(/https/);
  });

  it('rejects an API without credentials', () => {
    expect(() =>
      defineApi({ name: 'x', baseUrl: 'https://x.test', credentials: {}, methods: {} })
    ).toThrow(/credentials/);
  });
});

describe('store.apis', () => {
  it('sends the built request and parses the response', async () => {
    const calls = stubFetch(() => upstream('{"high":21}'));
    const result = await signedIn().call(weather, 'forecast', { city: 'wellington', days: 3 });
    expectTypeOf(result).toEqualTypeOf<{ high: number }>();
    expect(result).toEqual({ high: 21 });
    expect(calls[0]!.url).toBe('https://pact.test/apis/weather/call');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer pact_t');
    expect(await calls[0]!.json()).toEqual({
      baseUrl: 'https://api.weather.test/v2',
      method: 'GET',
      path: '/forecast/wellington',
      query: { days: '3' },
    });
  });

  it('sends a JSON body and accepts an empty response', async () => {
    const calls = stubFetch(() => upstream(null, 204, 'text/plain'));
    await expect(signedIn().call(weather, 'ping', {})).resolves.toBeUndefined();
    expect(await calls[0]!.json()).toMatchObject({ method: 'POST', body: { at: 1 } });
  });

  it('validates the input before sending', async () => {
    const calls = stubFetch(() => upstream('{}'));
    // @ts-expect-error city is required
    await expect(signedIn().call(weather, 'forecast', {})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('throws ApiResponseError for a non-2xx upstream status without signing out', async () => {
    stubFetch(() => upstream('bad key', 401, 'text/plain'));
    const onUnauthorized = vi.fn();
    const error = await signedIn(onUnauthorized)
      .call(weather, 'forecast', { city: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error).toMatchObject({ status: 401, body: 'bad key' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('signs out when the Pact token is rejected', async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    await expect(
      signedIn(onUnauthorized).call(weather, 'forecast', { city: 'x' })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('sends each credential with its placement after validating it', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await expect(
      signedIn().setCredentials(weather, { apiKey: 'short', project: 'p' })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);

    await signedIn().setCredentials(weather, { apiKey: 'sk-1234567890', project: 'p-42' });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('https://pact.test/apis/weather/credentials');
    expect(await calls[0]!.json()).toEqual({
      baseUrl: 'https://api.weather.test/v2',
      credentials: {
        apiKey: { in: 'header', name: 'Authorization', prefix: 'Bearer ', value: 'sk-1234567890' },
        project: { in: 'query', name: 'project', value: 'p-42' },
      },
    });
  });

  it('reports the credentials as ready only for the current base URL and fields', async () => {
    const status = { baseUrl: 'https://api.weather.test/v2', fields: ['apiKey'], updatedAt: 5 };
    stubFetch(() => Response.json(status));
    expect(await signedIn().credentials(weather)).toEqual({ ...status, ready: false });

    vi.restoreAllMocks();
    stubFetch(() => Response.json({ ...status, fields: ['apiKey', 'project'] }));
    expect(await signedIn().credentials(weather)).toMatchObject({ ready: true });
  });

  it('reports null when no credentials are set', async () => {
    stubFetch(() => Response.json({ error: 'none', code: 'not_found' }, { status: 404 }));
    expect(await signedIn().credentials(weather)).toBeNull();
  });

  it('throws without a request when signed out', async () => {
    const calls = stubFetch(() => new Response());
    const apis = createApis({ credentials: async () => null, onUnauthorized: () => {} });
    await expect(apis.deleteCredentials(weather)).rejects.toBeInstanceOf(SyncError);
    expect(calls).toHaveLength(0);
  });
});
