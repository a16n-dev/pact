import type { BaseDocument } from '../types';
import { fetchWithTimeout } from './http';

interface SyncDocument {
  id: string;
  collection: string;
  updatedAt: string;
  data: unknown;
}

interface PushResponse {
  accepted: number;
  skipped: number;
}

interface PullResponse {
  documents: SyncDocument[];
  cursor: number;
  // Absent from a pre-pagination server, which returns everything in one
  // response, so absent correctly means no more pages.
  hasMore?: boolean;
}

export type PingResult = { ok: true } | { ok: false; reason: 'url' | 'auth' | 'server' };

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'url' | 'auth' | 'server' };

/**
 * Trades the app password for a long-lived access token bound server-side to
 * `appName`, so later requests carry only the token. The caller persists
 * `clientId`; re-registering the same id replaces its previous token.
 */
export async function registerClient(
  url: string,
  password: string,
  appName: string,
  clientId: string,
  clientName: string
): Promise<RegisterResult> {
  const endpoint = `${url.replace(/\/+$/, '')}/auth/register`;
  let res: Response;
  try {
    res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${password}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appName, clientId, clientName }),
    });
  } catch (err) {
    console.warn(`Client register failed for ${endpoint}:`, err);
    return { ok: false, reason: 'url' };
  }
  if (res.status === 401) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'server' };
  const json = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (!json || typeof json.token !== 'string') return { ok: false, reason: 'server' };
  return { ok: true, token: json.token };
}

/**
 * Rewrites document bodies at the wire boundary (the hook end-to-end
 * encryption uses). `toWire` runs before push, `fromWire` after pull;
 * identity when absent.
 */
export interface SyncTransform {
  toWire(collection: string, doc: BaseDocument): Promise<unknown>;
  fromWire(collection: string, data: unknown): Promise<unknown>;
}

export class SyncClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly transform: SyncTransform | null;
  private readonly collectionKeys: ReadonlyMap<string, string> | null;

  constructor(
    endpoint: string,
    token: string,
    transform: SyncTransform | null = null,
    collectionKeys: ReadonlyMap<string, string> | null = null
  ) {
    this.endpoint = endpoint;
    this.token = token;
    this.transform = transform;
    this.collectionKeys = collectionKeys;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  // A collection travels under its `CollectionDefinition.key`. Resolved at each
  // method's entry so the URL, the per-doc `collection` field and the transform
  // all see the key; with encryption on, that binds wire envelopes to the same
  // identity local storage seals against (see AliasAdapter).
  private toKey(collection: string): string {
    return this.collectionKeys?.get(collection) ?? collection;
  }

  async ping(): Promise<PingResult> {
    const url = `${this.endpoint}/auth/check`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: this.authHeaders() });
    } catch (err) {
      console.warn(`Sync ping failed for ${url}:`, err);
      return { ok: false, reason: 'url' };
    }
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'auth' };
    return { ok: false, reason: 'server' };
  }

  async push(collection: string, docs: BaseDocument[]): Promise<PushResponse> {
    const key = this.toKey(collection);
    const syncDocs: SyncDocument[] = await Promise.all(
      docs.map(async (doc) => ({
        id: doc.id,
        collection: key,
        updatedAt: doc.updatedAt,
        data: this.transform ? await this.transform.toWire(key, doc) : doc,
      }))
    );

    const res = await fetchWithTimeout(`${this.endpoint}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ documents: syncDocs }),
    });

    if (!res.ok) {
      throw new Error(`Sync push failed: ${res.status}`);
    }

    return res.json() as Promise<PushResponse>;
  }

  async pull<T extends BaseDocument>(
    collection: string,
    cursor: number
  ): Promise<{ documents: T[]; cursor: number; hasMore: boolean }> {
    const key = this.toKey(collection);
    const params = new URLSearchParams({ collection: key, cursor: String(cursor) });
    const res = await fetchWithTimeout(`${this.endpoint}/sync/pull?${params}`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Sync pull failed: ${res.status}`);
    }

    const result = (await res.json()) as PullResponse;
    return {
      documents: await Promise.all(
        result.documents.map(async (d) =>
          this.transform ? ((await this.transform.fromWire(key, d.data)) as T) : (d.data as T)
        )
      ),
      cursor: result.cursor,
      hasMore: result.hasMore ?? false,
    };
  }

  async pullDocument<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    const key = this.toKey(collection);
    const params = new URLSearchParams({ collection: key, id });
    const res = await fetchWithTimeout(`${this.endpoint}/sync/pull?${params}`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Sync pull failed: ${res.status}`);
    }

    const result = (await res.json()) as PullResponse;
    if (!result.documents[0]) return null;
    const data = result.documents[0].data;
    return (this.transform ? await this.transform.fromWire(key, data) : data) as T;
  }
}
