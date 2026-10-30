import { SyncError, UnauthorizedError, failed } from '../sync/http';
import type { DecisionRequest, GeneratedImage, ImageRequest, StoreAi } from '../store/namespaces';

type Credentials = { url: string; token: string };

type AiDeps = {
  credentials(): Promise<Credentials | null>;
  onUnauthorized(): void;
};

export function createAi(deps: AiDeps): StoreAi {
  const post = async (path: string, body: unknown): Promise<Response> => {
    const creds = await deps.credentials();
    if (!creds) throw new SyncError(401, 'signed_out', 'Sign in to a Pact server to use AI');
    // No timeout: generating an image can take well over a minute.
    const res = await fetch(`${creds.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    try {
      return await failed(res);
    } catch (error) {
      if (error instanceof UnauthorizedError) deps.onUnauthorized();
      throw error;
    }
  };

  return {
    async image(request: ImageRequest): Promise<GeneratedImage> {
      const res = await post('/ai/images', request);
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    async decide<Q extends Record<string, unknown>>(
      request: DecisionRequest<Q>
    ): Promise<Record<keyof Q, unknown>> {
      const res = await post('/ai/decide', request);
      const body = (await res.json()) as { answers: Record<keyof Q, unknown> };
      return body.answers;
    },
  };
}
