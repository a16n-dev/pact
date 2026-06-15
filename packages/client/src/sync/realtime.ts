// WebSocket lifecycle for server-pushed cache invalidations. Probes /info
// before opening so we silently no-op against servers without the realtime
// feature flag enabled.

import { fetchWithTimeout } from './http';

interface InvalidateMessage {
  type: 'invalidate';
  collections: string[];
}

export interface RealtimeOptions {
  url: string;
  token: string;
  onInvalidate: (collection: string) => void;
  onReconnect: () => void;
}

export class RealtimeConnection {
  private readonly opts: RealtimeOptions;
  private ws: WebSocket | null = null;
  private closed = false;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RealtimeOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const baseUrl = this.opts.url.replace(/\/+$/, '');
    let info: { realtime?: unknown } | null = null;
    try {
      const res = await fetchWithTimeout(`${baseUrl}/info`, {}, 10_000);
      if (res.ok) info = (await res.json()) as { realtime?: unknown };
    } catch {
      // network down at boot; reconnect logic doesn't kick in unless we
      // opened a socket once. Bail; foreground sync handles initial backfill.
      return;
    }
    if (info?.realtime !== true) return;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.closed) return;
    const wsUrl =
      this.opts.url.replace(/^http/, 'ws').replace(/\/+$/, '') +
      `/realtime?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.opts.onReconnect();
    };
    ws.onmessage = (e) => {
      try {
        const raw = typeof e.data === 'string' ? e.data : '';
        const msg = JSON.parse(raw) as Partial<InvalidateMessage>;
        if (msg?.type !== 'invalidate' || !Array.isArray(msg.collections)) return;
        for (const c of msg.collections) {
          if (typeof c === 'string') this.opts.onInvalidate(c);
        }
      } catch {
        // ignore malformed payloads
      }
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retries++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
