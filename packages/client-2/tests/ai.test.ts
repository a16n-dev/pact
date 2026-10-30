import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAi } from '../src/ai/ai';
import { SyncError, UnauthorizedError } from '../src/sync/http';

const CREDS = { url: 'https://pact.test', token: 'pact_t' };

function stubFetch(respond: (req: Request) => Response): Request[] {
  const calls: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    return respond(req);
  });
  return calls;
}

function signedIn(onUnauthorized = () => {}) {
  return createAi({ credentials: async () => CREDS, onUnauthorized });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('store.ai', () => {
  it('posts an image request and returns the bytes with their type', async () => {
    const calls = stubFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    );
    const image = await signedIn().image({ model: 'openai/gpt-image-1', prompt: 'an onion' });
    expect(image).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
    expect(calls[0]!.url).toBe('https://pact.test/ai/images');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer pact_t');
    expect(await calls[0]!.json()).toEqual({ model: 'openai/gpt-image-1', prompt: 'an onion' });
  });

  it('returns the answers to a decision', async () => {
    stubFetch(() => Response.json({ answers: { ripe: { type: 'noul', noul: 0.8 } } }));
    const answers = await signedIn().decide({ model: 'typesafe/jev', questions: { ripe: {} } });
    expect(answers).toEqual({ ripe: { type: 'noul', noul: 0.8 } });
  });

  it('throws without a request when signed out', async () => {
    const calls = stubFetch(() => new Response());
    const ai = createAi({ credentials: async () => null, onUnauthorized: () => {} });
    await expect(ai.decide({ model: 'm/x', questions: {} })).rejects.toBeInstanceOf(SyncError);
    expect(calls).toHaveLength(0);
  });

  it('signs out when the token is rejected', async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    await expect(
      signedIn(onUnauthorized).image({ model: 'm/x', prompt: 'p' })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('surfaces the server error code', async () => {
    stubFetch(() =>
      Response.json({ error: 'AI is turned off', code: 'ai_disabled' }, { status: 403 })
    );
    await expect(signedIn().image({ model: 'm/x', prompt: 'p' })).rejects.toMatchObject({
      status: 403,
      code: 'ai_disabled',
    });
  });
});
