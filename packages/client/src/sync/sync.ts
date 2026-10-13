import type { BaseDocument } from '../types';
import { fetchWithTimeout } from './http';
import { foldSiblings, type PulledDocument } from './fold';

/**
 * The sync protocol this client speaks, sent on every request. The server
 * advertises its own range on `GET /info` and refuses (426) anything
 * outside it; see `PingResult`'s `'protocol'` reason. v4: per-client
 * document rows folded on the client, app-wide pull cursor.
 */
export const PROTOCOL_VERSION = 4;
const PROTOCOL_HEADER = 'x-pact-protocol';

interface SyncDocument {
  id: string;
  collection: string;
  // The document's own updatedAt, repeated outside the (possibly sealed)
  // body so siblings fold without opening envelopes, and so the server can
  // keep this client's own row from moving backwards.
  updatedAt: string;
  // The document body (or its sealed envelope). Opaque to the server.
  data: unknown;
  // Set by the server on pull: whose row this is, and its write sequence.
  clientId?: string;
  seq?: number;
}

interface PushResponse {
  accepted: number;
}

interface PullResponse {
  documents: SyncDocument[];
  cursor: number;
  hasMore: boolean;
}

/**
 * `'protocol'`: the server refused this client's protocol version (426) —
 * one side needs upgrading. Surfaced as its own reason so apps can show an
 * "update the app" message rather than a generic sync failure.
 */
export type PingResult =
  | { ok: true }
  | { ok: false; reason: 'url' | 'auth' | 'server' | 'protocol' };

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'url' | 'auth' | 'server' | 'protocol' };

function protocolHeaders(): Record<string, string> {
  return { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
}

/**
 * One-time exchange: trade the app's password for a long-lived per-client
 * access token. `appName` names which app on a (possibly multi-tenant)
 * server this client belongs to; the returned token is bound to that app
 * server-side, so no later request needs to carry it. The clientId is
 * supplied by the caller (persisted locally so it survives retries and
 * reinstalls). Re-registering the same clientId replaces the previous token.
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
        ...protocolHeaders(),
      },
      body: JSON.stringify({ appName, clientId, clientName }),
    });
  } catch (err) {
    console.warn(`Client register failed for ${endpoint}:`, err);
    return { ok: false, reason: 'url' };
  }
  if (res.status === 426) return { ok: false, reason: 'protocol' };
  if (res.status === 401) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'server' };
  const json = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (!json || typeof json.token !== 'string') return { ok: false, reason: 'server' };
  return { ok: true, token: json.token };
}

/**
 * Optional wire transform applied to document bodies at the sync boundary —
 * the hook end-to-end encryption uses. `toWire` shapes a local doc into what
 * the server stores; `fromWire` reverses it on pull. Identity when absent.
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
  // Reverse of `collectionKeys`: wire key → local name, for rows coming back.
  private readonly collectionNames: ReadonlyMap<string, string> | null;

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
    this.collectionNames = collectionKeys
      ? new Map(Array.from(collectionKeys, ([name, key]) => [key, name]))
      : null;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...protocolHeaders() };
  }

  /**
   * The wire identity of a collection: its `CollectionDefinition.key` when the
   * domain aliases it, the name itself otherwise. Applied at each method's
   * entry so the URL, the per-doc `collection` field, *and* the transform all
   * see the key — with encryption on, that binds wire envelopes to the same
   * identity local storage seals against (see `AliasAdapter`).
   */
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
    if (res.status === 426) return { ok: false, reason: 'protocol' };
    if (res.status === 401) return { ok: false, reason: 'auth' };
    return { ok: false, reason: 'server' };
  }

  /** Write `docs` into this client's own server rows. */
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

  /**
   * Fold a response's rows to one winner per document, *then* decode only
   * the winners. The fold runs on the cleartext row fields (`updatedAt`,
   * `clientId`), so a losing sibling sealed under a key this device can't
   * open never reaches the transform — in strict encryption mode that would
   * throw and wedge the pull on a row that was going to lose anyway.
   */
  private async decodeWinners<T extends BaseDocument>(
    rows: SyncDocument[]
  ): Promise<PulledDocument<T>[]> {
    return Promise.all(
      foldSiblings(rows).map(async (row) => {
        // The row names its collection by wire key; the transform speaks keys
        // too, so decode under the key and only then translate to the local name.
        const key = row.collection;
        const doc = (this.transform ? await this.transform.fromWire(key, row.data) : row.data) as T;
        const collection = this.collectionNames?.get(key) ?? key;
        return { doc, collection, clientId: row.clientId, seq: row.seq };
      })
    );
  }

  /**
   * One page of the app's rows written after `cursor`, across every
   * collection, folded to one winner per document (see `fold.ts`).
   */
  async pull<T extends BaseDocument>(
    cursor: number
  ): Promise<{ documents: PulledDocument<T>[]; cursor: number; hasMore: boolean }> {
    const params = new URLSearchParams({ cursor: String(cursor) });
    const res = await fetchWithTimeout(`${this.endpoint}/sync/pull?${params}`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Sync pull failed: ${res.status}`);
    }

    const result = (await res.json()) as PullResponse;
    return {
      documents: await this.decodeWinners<T>(result.documents),
      cursor: result.cursor,
      hasMore: result.hasMore,
    };
  }

  /** The winning row for one document, folded from its siblings; null if unknown. */
  async pullDocument<T extends BaseDocument>(
    collection: string,
    id: string
  ): Promise<PulledDocument<T> | null> {
    const key = this.toKey(collection);
    const params = new URLSearchParams({ collection: key, id });
    const res = await fetchWithTimeout(`${this.endpoint}/sync/pull?${params}`, {
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Sync pull failed: ${res.status}`);
    }

    const result = (await res.json()) as PullResponse;
    return (await this.decodeWinners<T>(result.documents))[0] ?? null;
  }
}
