import { randomId } from '../src/lib/ids';

// An in-memory server implementing packages/server-2/api.md as far as a
// client can observe it: discovery, the token exchange, sessions, push and
// pull, blobs and the realtime socket. Sign-in skips the HTML login page;
// `authorize()` plays the user who signs in and returns the redirect.

type Version = {
  collection: string;
  id: string;
  writer_id: string;
  hlc: string;
  seq: number;
  data: string;
};

type Token = {
  token: string;
  appId: string;
  writerId: string;
  user: string | null;
  deviceName: string;
};

type App = {
  seq: number;
  versions: Map<string, Version>;
  blobs: Map<string, { bytes: Uint8Array; contentType: string }>;
  redirectUris: Set<string>;
};

type AuthCode = {
  code: string;
  appId: string;
  deviceId: string;
  deviceName: string;
  redirectUri: string;
  challenge: string;
  used: boolean;
};

const PAGE_SIZE = 500;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(status: number, code: string): Response {
  return json(status, { error: code, code });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class FakeServer {
  readonly origin = 'https://sync.test';
  maxPushDocuments = 50;
  readonly requests: Array<{ method: string; path: string }> = [];
  private readonly apps = new Map<string, App>();
  private readonly tokens = new Map<string, Token>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly users = new Map<string, string>();
  private readonly sockets = new Map<string, Set<FakeSocket>>();
  /** When set, every request fails as if the network were down. */
  offline = false;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push({ method, path: url.pathname + url.search });
    if (this.offline) throw new TypeError('fetch failed');
    if (url.origin !== this.origin) return error(404, 'not_found');
    const headers = new Headers(init?.headers);
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const path = url.pathname;

    if (path === '/.well-known/pact') {
      return json(200, {
        version: 2,
        authorize_url: `${this.origin}/oauth/authorize`,
        token_url: `${this.origin}/oauth/token`,
        max_push_documents: this.maxPushDocuments,
      });
    }
    if (path === '/oauth/token' && method === 'POST') return this.exchange(init?.body);

    const auth = bearer ? this.tokens.get(bearer) : undefined;
    if (!auth) return error(401, 'unauthorized');
    const app = this.app(auth.appId);

    if (path === '/auth/check') {
      return json(200, { app_id: auth.appId, user: auth.user, device_name: auth.deviceName });
    }
    if (path === '/auth/signout' && method === 'POST') {
      this.revoke(auth.token);
      return new Response(null, { status: 204 });
    }
    if (path === '/sync/push' && method === 'POST') return this.push(app, auth, init?.body);
    if (path === '/sync/pull') return this.pull(app, url.searchParams);
    if (path === '/sync/blobs' && method === 'GET') {
      return json(200, { hashes: Array.from(app.blobs.keys()) });
    }
    const blob = /^\/sync\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (blob && method === 'PUT') {
      const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      if ((await sha256Hex(bytes)) !== blob[1]) return error(400, 'hash_mismatch');
      if (!app.blobs.has(blob[1]!)) {
        app.blobs.set(blob[1]!, {
          bytes,
          contentType: headers.get('content-type') ?? 'application/octet-stream',
        });
      }
      return new Response(null, { status: 204 });
    }
    if (blob && method === 'GET') {
      const stored = app.blobs.get(blob[1]!);
      if (!stored) return error(404, 'not_found');
      return new Response(stored.bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'content-type': stored.contentType },
      });
    }
    return error(404, 'not_found');
  };

  readonly WebSocket = socketClassFor(this);

  // Admin-side setup

  createApp(appId: string, redirectUris: string[] = ['https://app.test/callback']): void {
    this.apps.set(appId, {
      seq: 1_000,
      versions: new Map(),
      blobs: new Map(),
      redirectUris: new Set(redirectUris),
    });
  }

  createUser(username: string, password: string): void {
    this.users.set(username, password);
  }

  /** An admin-minted API token with its own writer id. */
  apiToken(appId: string): string {
    const token = `pact_${randomId(20)}`;
    this.tokens.set(token, {
      token,
      appId,
      writerId: `api-${randomId(6)}`,
      user: null,
      deviceName: 'api',
    });
    return token;
  }

  revoke(token: string): void {
    const auth = this.tokens.get(token);
    if (!auth) return;
    this.tokens.delete(token);
    for (const socket of this.sockets.get(auth.appId) ?? []) {
      if (socket.token === token) socket.serverClose(1000, 'signed out');
    }
  }

  /** The user signs in on the authorize page; returns the redirect's query, or an error. */
  authorize(
    authorizeUrl: string,
    credentials: { username: string; password: string }
  ): { code: string; state: string } | { error: string } {
    const url = new URL(authorizeUrl);
    const p = url.searchParams;
    const required = [
      'app_id',
      'redirect_uri',
      'device_id',
      'device_name',
      'state',
      'code_challenge',
      'code_challenge_method',
    ];
    for (const name of required) if (!p.get(name)) return { error: `missing ${name}` };
    if (p.get('code_challenge_method') !== 'S256') return { error: 'bad method' };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(p.get('device_id')!)) return { error: 'bad device_id' };
    const app = this.apps.get(p.get('app_id')!);
    if (!app) return { error: 'unknown app' };
    if (!app.redirectUris.has(p.get('redirect_uri')!)) return { error: 'unknown redirect_uri' };
    if (this.users.get(credentials.username) !== credentials.password) {
      return { error: 'bad credentials' };
    }
    const code = randomId(24);
    this.codes.set(code, {
      code,
      appId: p.get('app_id')!,
      deviceId: p.get('device_id')!,
      deviceName: p.get('device_name')!,
      redirectUri: p.get('redirect_uri')!,
      challenge: p.get('code_challenge')!,
      used: false,
    });
    this.lastUser = credentials.username;
    return { code, state: p.get('state')! };
  }

  private lastUser = '';

  /** The server's view of what a writer stored. */
  versionsOf(appId: string, collection: string, id: string): Version[] {
    return Array.from(this.app(appId).versions.values())
      .filter((v) => v.collection === collection && v.id === id)
      .sort((a, b) => a.seq - b.seq);
  }

  tokensFor(appId: string): Token[] {
    return Array.from(this.tokens.values()).filter((t) => t.appId === appId);
  }

  /** Writes a version directly, as another device would. */
  seed(
    token: string,
    documents: Array<{ collection: string; id: string; hlc: string; data: string }>
  ): number {
    const auth = this.tokens.get(token)!;
    return this.write(this.app(auth.appId), auth, documents);
  }

  // Internals

  private app(appId: string): App {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`Unknown app ${appId}`);
    return app;
  }

  private async exchange(body: BodyInit | null | undefined): Promise<Response> {
    const params = JSON.parse(String(body)) as Record<string, string>;
    if (params.grant_type !== 'authorization_code')
      return json(400, { error: 'unsupported_grant_type' });
    const code = this.codes.get(params.code ?? '');
    if (
      !code ||
      code.used ||
      code.appId !== params.app_id ||
      code.redirectUri !== params.redirect_uri ||
      (await s256(params.code_verifier ?? '')) !== code.challenge
    ) {
      return json(400, { error: 'invalid_grant' });
    }
    code.used = true;
    // Same device id keeps the same writer; a fresh sign-in rotates the token.
    const writerId = `${code.appId}:${code.deviceId}`;
    for (const [token, auth] of this.tokens) {
      if (auth.writerId === writerId) this.tokens.delete(token);
    }
    const token = `pact_${randomId(20)}`;
    this.tokens.set(token, {
      token,
      appId: code.appId,
      writerId,
      user: this.lastUser,
      deviceName: code.deviceName,
    });
    return json(200, { access_token: token, token_type: 'bearer' });
  }

  private push(app: App, auth: Token, body: BodyInit | null | undefined): Response {
    const { documents } = JSON.parse(String(body)) as {
      documents: Array<{ collection: string; id: string; hlc: string; data: string }>;
    };
    if (!Array.isArray(documents)) return error(400, 'bad_request');
    if (documents.length > this.maxPushDocuments) return error(413, 'too_many_documents');
    for (const doc of documents) {
      if (new TextEncoder().encode(doc.data).length > 1_000_000)
        return error(413, 'document_too_large');
      if (doc.hlc.length < 1 || doc.hlc.length > 64) return error(400, 'bad_request');
    }
    const seq = this.write(app, auth, documents);
    return json(200, { seq });
  }

  private write(
    app: App,
    auth: Token,
    documents: Array<{ collection: string; id: string; hlc: string; data: string }>
  ): number {
    for (const doc of documents) {
      app.seq += 1;
      app.versions.set(`${doc.collection}\u0000${doc.id}\u0000${auth.writerId}`, {
        collection: doc.collection,
        id: doc.id,
        writer_id: auth.writerId,
        hlc: doc.hlc,
        seq: app.seq,
        data: doc.data,
      });
    }
    if (documents.length > 0) {
      for (const socket of this.sockets.get(auth.appId) ?? []) {
        socket.serverMessage(JSON.stringify({ type: 'changed', seq: app.seq }));
      }
    }
    return app.seq;
  }

  private pull(app: App, params: URLSearchParams): Response {
    const id = params.get('id');
    const collections = params.getAll('collection');
    if (id !== null) {
      if (collections.length !== 1) return error(400, 'bad_request');
      const docs = Array.from(app.versions.values())
        .filter((v) => v.collection === collections[0] && v.id === id)
        .sort((a, b) => a.seq - b.seq);
      return json(200, { documents: docs, cursor: 0, hasMore: false });
    }
    const cursor = Number(params.get('cursor'));
    if (!Number.isInteger(cursor) || cursor < 0) return error(400, 'bad_request');
    const all = Array.from(app.versions.values())
      .filter(
        (v) => v.seq > cursor && (collections.length === 0 || collections.includes(v.collection))
      )
      .sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, PAGE_SIZE);
    return json(200, {
      documents: page,
      cursor: page.length > 0 ? page[page.length - 1]!.seq : cursor,
      hasMore: all.length > PAGE_SIZE,
    });
  }

  attach(socket: FakeSocket): boolean {
    const auth = this.tokens.get(socket.token);
    if (!auth) return false;
    let set = this.sockets.get(auth.appId);
    if (!set) {
      set = new Set();
      this.sockets.set(auth.appId, set);
    }
    set.add(socket);
    return true;
  }

  detach(socket: FakeSocket): void {
    for (const set of this.sockets.values()) set.delete(socket);
  }

  openSockets(appId: string): number {
    return this.sockets.get(appId)?.size ?? 0;
  }
}

function socketClassFor(server: FakeServer): new (url: string) => FakeSocket {
  return class extends FakeSocket {
    constructor(url: string) {
      super(server, url);
    }
  };
}

class FakeSocket {
  readonly token: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly server: FakeServer;
  open = false;

  constructor(server: FakeServer, url: string) {
    this.server = server;
    this.token = new URL(url).searchParams.get('token') ?? '';
    queueMicrotask(() => {
      if (!this.server.attach(this)) {
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.open = true;
      this.onopen?.();
    });
  }

  send(): void {}

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.server.detach(this);
    this.onclose?.({ code: 1005, reason: '' });
  }

  serverMessage(data: string): void {
    if (this.open) this.onmessage?.({ data });
  }

  serverClose(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.server.detach(this);
    this.onclose?.({ code, reason });
  }
}
