import { authedFetch, type AuthedFetchDeps } from '../sync/authedFetch';
import { SyncError } from '../sync/http';
import type { StoreApis } from '../store/namespaces';
import type { ApiDefinition, ApiRequest } from './api';

/** The API itself answered with a status outside 2xx. */
export class ApiResponseError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(api: string, status: number, body: string) {
    super(`${api} returned ${status}`);
    this.name = 'ApiResponseError';
    this.status = status;
    this.body = body;
  }
}

export function createApis(deps: AuthedFetchDeps): StoreApis {
  const send = authedFetch(deps, 'Sign in to a Pact server to use third-party APIs');
  const credentialsPath = (api: ApiDefinition) =>
    `/apis/${encodeURIComponent(api.name)}/credentials`;

  return {
    async call(api, method, input, opts) {
      const definition = api.methods[method];
      if (!definition) throw new Error(`API "${api.name}" has no method "${String(method)}"`);
      const request = definition.build(definition.request.parse(input));
      const res = await send(`/apis/${encodeURIComponent(api.name)}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wireRequest(api.baseUrl, request)),
        signal: opts?.signal,
      });
      const status = Number(res.headers.get('pact-upstream-status'));
      const text = await res.text();
      if (status < 200 || status > 299) throw new ApiResponseError(api.name, status, text);
      const isJson = /\bjson\b/.test(res.headers.get('content-type') ?? '');
      const body: unknown = text === '' ? undefined : isJson ? JSON.parse(text) : text;
      return definition.response.parse(body);
    },

    async setCredentials(api, values) {
      const credentials: Record<string, unknown> = {};
      for (const [field, { schema, ...placement }] of Object.entries(api.credentials)) {
        const value = schema.parse((values as Record<string, unknown>)[field]);
        credentials[field] = { ...placement, value };
      }
      await send(credentialsPath(api), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: api.baseUrl, credentials }),
      });
    },

    async deleteCredentials(api) {
      await send(credentialsPath(api), { method: 'DELETE' });
    },

    async credentials(api) {
      let res: Response;
      try {
        res = await send(credentialsPath(api));
      } catch (error) {
        if (error instanceof SyncError && error.status === 404) return null;
        throw error;
      }
      const status = (await res.json()) as { baseUrl: string; fields: string[]; updatedAt: number };
      return {
        ...status,
        ready:
          status.baseUrl === api.baseUrl &&
          Object.keys(api.credentials).every((field) => status.fields.includes(field)),
      };
    },
  };
}

function wireRequest(baseUrl: string, request: ApiRequest) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) query[key] = String(value);
  }
  return {
    baseUrl,
    method: request.method ?? 'GET',
    path: request.path,
    query,
    headers: request.headers,
    body: request.body,
  };
}
