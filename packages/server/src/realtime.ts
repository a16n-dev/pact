import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

interface InvalidateMessage {
  type: 'invalidate';
  collections: string[];
}

export class RealtimeDO extends DurableObject<Env> {
  broadcast(collections: string[]): void {
    if (collections.length === 0) return;
    const msg: InvalidateMessage = { type: 'invalidate', collections };
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Peer is gone — webSocketClose will reap the entry shortly.
      }
    }
  }

  async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): void {
    // No client-to-server messages in v1.
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
