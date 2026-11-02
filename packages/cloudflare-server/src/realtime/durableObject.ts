import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../lib/env';

export const TOKEN_ID_HEADER = 'x-pact-token-id';

export class RealtimeDO extends DurableObject<Env> {
  broadcast(seq: number): void {
    const payload = JSON.stringify({ type: 'changed', seq });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // The peer is gone; webSocketClose reaps it shortly.
      }
    }
  }

  closeToken(tokenId: string): void {
    for (const ws of this.ctx.getWebSockets(tokenId)) {
      try {
        ws.close(1000, 'signed out');
      } catch {
        // Already closed.
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const tokenId = req.headers.get(TOKEN_ID_HEADER);
    if (!tokenId) return new Response(null, { status: 400 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tokenId]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(): void {}

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
}

function realtimeFor(env: Env, appId: string): DurableObjectStub<RealtimeDO> {
  return env.REALTIME.get(env.REALTIME.idFromName(appId));
}

// Realtime is best effort: by the time it runs the write or revocation has already committed, so
// a Durable Object hiccup must not turn into a failed request.
export function notifyRealtime(
  env: Env,
  appId: string,
  call: (realtime: DurableObjectStub<RealtimeDO>) => Promise<void>
): Promise<void> {
  return call(realtimeFor(env, appId)).catch(() => {});
}
