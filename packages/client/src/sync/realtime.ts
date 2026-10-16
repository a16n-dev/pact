import { fetchWithTimeout } from './http';

interface InvalidateMessage {
  type: 'invalidate';
  collections: string[];
}

export interface RealtimeOptions {
  url: string;
  token: string;
  /** Receives the collection's wire key, not its local name. */
  onInvalidate: (collection: string) => void;
  /** Fires on every open, including the first, so the caller can backfill. */
  onReconnect: () => void;
}

/** `start` probes `/info` first and is a silent no-op when the server lacks realtime. */
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
      // Offline at boot. Reconnects only begin once a socket has opened, so
      // give up here; foreground sync covers the backfill.
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
      } catch {}
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  // Exponential backoff from 500ms, capped at 30s; reset on a successful open.
  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retries++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
