type ChangedMessage = { type: 'changed'; seq: number };

export type RealtimeOptions = {
  url: string;
  token: string;
  onOpen: () => void;
  onChanged: (seq: number) => void;
  /** The server closed the socket because the token is gone; no reconnect follows. */
  onSignedOut: () => void;
};

export class RealtimeConnection {
  private readonly opts: RealtimeOptions;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RealtimeOptions) {
    this.opts = opts;
  }

  start(): void {
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  private open(): void {
    if (this.stopped) return;
    const wsUrl =
      this.opts.url.replace(/^http/, 'ws') +
      `/realtime?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.opts.onOpen();
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : '') as Partial<ChangedMessage>;
        if (msg?.type === 'changed' && typeof msg.seq === 'number') this.opts.onChanged(msg.seq);
      } catch {}
    };
    ws.onclose = (e) => {
      if (e.code === 1000 && e.reason === 'signed out') {
        this.stop();
        this.opts.onSignedOut();
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  // Exponential backoff from 500ms, capped at 30s; reset on a successful open.
  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retries++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
