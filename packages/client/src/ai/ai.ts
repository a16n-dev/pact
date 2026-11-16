import { authedFetch, type AuthedFetchDeps } from '../sync/authedFetch';
import type { DecisionRequest, GeneratedImage, ImageRequest, StoreAi } from '../store/namespaces';

export function createAi(deps: AuthedFetchDeps): StoreAi {
  const send = authedFetch(deps, 'Sign in to a Pact server to use AI');
  const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
    send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  return {
    async image(request: ImageRequest, opts?: { signal?: AbortSignal }): Promise<GeneratedImage> {
      const res = await post('/ai/images', request, opts?.signal);
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    async decide<Q extends Record<string, unknown>>(
      request: DecisionRequest<Q>,
      opts?: { signal?: AbortSignal }
    ): Promise<Record<keyof Q, unknown>> {
      const res = await post('/ai/decide', request, opts?.signal);
      const body = (await res.json()) as { answers: Record<keyof Q, unknown> };
      return body.answers;
    },
  };
}
