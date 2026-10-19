const TIMEOUT_MS = 15_000;

/** The token is gone for good: clear it and send the user through sign-in again. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class SyncError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.code = code;
  }
}

// A stalled server would otherwise hang sync indefinitely. AbortController +
// setTimeout rather than AbortSignal.timeout, which Hermes (React Native) lacks.
export async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function failed(res: Response): Promise<never> {
  if (res.status === 401) throw new UnauthorizedError();
  const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : null;
  const message = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
  throw new SyncError(res.status, code, message);
}

export type Discovery = {
  authorizeUrl: string;
  tokenUrl: string;
  maxPushDocuments: number;
};

export async function discover(url: string): Promise<Discovery> {
  const res = await fetchWithTimeout(`${url}/.well-known/pact`);
  if (!res.ok) await failed(res);
  const body = (await res.json()) as {
    version: number;
    authorize_url: string;
    token_url: string;
    max_push_documents: number;
  };
  if (body.version !== 2) throw new Error(`Unsupported Pact server version ${body.version}`);
  return {
    authorizeUrl: body.authorize_url,
    tokenUrl: body.token_url,
    maxPushDocuments: body.max_push_documents,
  };
}

export type TokenExchange = {
  tokenUrl: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  appId: string;
};

export type ExchangeResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'code' | 'network' | 'server' };

export async function exchangeCode(exchange: TokenExchange): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(exchange.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: exchange.code,
        code_verifier: exchange.codeVerifier,
        redirect_uri: exchange.redirectUri,
        app_id: exchange.appId,
      }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (res.status === 400) return { ok: false, reason: 'code' };
  if (!res.ok) return { ok: false, reason: 'server' };
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!body || typeof body.access_token !== 'string') return { ok: false, reason: 'server' };
  return { ok: true, token: body.access_token };
}

export type WireDocument = { collection: string; id: string; hlc: string; data: string };

export type WireVersion = WireDocument & { writer_id: string; seq: number };

export type PullPage = { documents: WireVersion[]; cursor: number; hasMore: boolean };

export type SessionInfo = { appId: string; user: string | null; deviceName: string };

export class SyncHttp {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchWithTimeout(`${this.url}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) await failed(res);
    return res;
  }

  async check(): Promise<SessionInfo> {
    const body = (await (await this.request('/auth/check')).json()) as {
      app_id: string;
      user: string | null;
      device_name: string;
    };
    return { appId: body.app_id, user: body.user, deviceName: body.device_name };
  }

  async signOut(): Promise<void> {
    await this.request('/auth/signout', { method: 'POST' });
  }

  async push(documents: readonly WireDocument[]): Promise<number> {
    const res = await this.request('/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents }),
    });
    return ((await res.json()) as { seq: number }).seq;
  }

  async pull(cursor: number, collection?: string): Promise<PullPage> {
    const params = new URLSearchParams({ cursor: String(cursor) });
    if (collection !== undefined) params.set('collection', collection);
    return (await (await this.request(`/sync/pull?${params}`)).json()) as PullPage;
  }

  async pullDocument(collection: string, id: string): Promise<WireVersion[]> {
    const params = new URLSearchParams({ collection, id });
    const page = (await (await this.request(`/sync/pull?${params}`)).json()) as PullPage;
    return page.documents;
  }
}
