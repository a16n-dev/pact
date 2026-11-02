import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { api, doc, ORIGIN, push, seedApp } from './helpers';

async function connect(token: string, origin?: string) {
  const headers: Record<string, string> = { upgrade: 'websocket' };
  if (origin) headers.origin = origin;
  const res = await SELF.fetch(`${ORIGIN}/realtime?token=${token}`, { headers });
  return res;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) =>
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true })
  );
}

function closed(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
}

describe('realtime', () => {
  it('rejects bad tokens and disallowed origins', async () => {
    const a = await seedApp('rt-reject');
    expect((await connect('pact_nope')).status).toBe(401);
    expect((await connect(a.token, 'https://evil.example')).status).toBe(403);
    expect((await SELF.fetch(`${ORIGIN}/realtime?token=${a.token}`)).status).toBe(426);
  });

  it('broadcasts the new seq to the app after a push, and only to that app', async () => {
    const a = await seedApp('rt-a');
    const b = await seedApp('rt-b');
    const resA = await connect(a.token, 'http://localhost:3000');
    expect(resA.status).toBe(101);
    const wsA = resA.webSocket!;
    wsA.accept();
    const wsB = (await connect(b.token)).webSocket!;
    wsB.accept();
    let bHeard = false;
    wsB.addEventListener('message', () => {
      bHeard = true;
    });

    const message = nextMessage(wsA);
    const { seq } = (await (await push(a.token, [doc('n1', 'x')])).json()) as { seq: number };
    expect(JSON.parse(await message)).toEqual({ type: 'changed', seq });
    expect(bHeard).toBe(false);
  });

  it('closes the socket on sign-out', async () => {
    const a = await seedApp('rt-signout');
    const ws = (await connect(a.token)).webSocket!;
    ws.accept();
    const done = closed(ws);
    expect((await api('/auth/signout', a.token, { method: 'POST' })).status).toBe(204);
    expect((await done).code).toBe(1000);
  });
});
