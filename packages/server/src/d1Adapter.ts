import type { BaseDocument, DatabaseAdapter } from '@pact/client';
import {
  pullDocument,
  pullDocumentsSince,
  pushDocuments,
  wipeAllDocumentsViaApi,
  type SyncHooks,
} from './sync/api';
import type { Env } from './types';

export interface D1AdapterOptions {
  env: Env;
  /**
   * Document collections this adapter reports from `listCollections()`.
   * Internal `_`-prefixed collections are handled separately and need not be
   * listed.
   */
  collections: readonly string[];
  /**
   * Push hooks shared with the HTTP push handler. Passing the same hooks
   * keeps writes from inside the Worker (e.g. MCP tools) and writes from
   * outside (app/cli) on identical migrate + validation paths.
   */
  hooks?: SyncHooks;
  /**
   * DurableObject ctx wait-until, used so accepted writes broadcast realtime
   * invalidations. Optional — without it, writes still land but connected
   * clients only see them on their next pull.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * DatabaseAdapter that reads/writes the deployed Worker's D1 documents table
 * via the @pact/server programmatic API. In-Worker consumers (notably an MCP
 * agent's tool layer) use this so they share one source of truth with the
 * HTTP sync surface — no loopback fetch, no schema divergence. The Store this
 * backs is the same `@pact/client` Store other clients build on, so tool and
 * client code can share repositories on top of it.
 *
 * The Store's client-side sync bookkeeping collections (`_config`,
 * `_sync_meta`, `_outbox`) are inert: reads return empty, writes drop — they
 * have no meaning when the adapter IS the source of truth. Other `_`-prefixed
 * collections (e.g. the `_seeds` marker) persist to D1 like any document;
 * clients never pull them because sync is per-requested-collection.
 */
export class D1Adapter implements DatabaseAdapter {
  constructor(private readonly opts: D1AdapterOptions) {}

  private isInternal(collection: string): boolean {
    return collection === '_config' || collection === '_sync_meta' || collection === '_outbox';
  }

  async get<T extends BaseDocument>(collection: string, id: string): Promise<T | null> {
    if (this.isInternal(collection)) return null;
    const row = await pullDocument(this.opts.env, collection, id);
    return row ? (row.data as T) : null;
  }

  async getMany<T extends BaseDocument>(collection: string, ids: string[]): Promise<T[]> {
    if (this.isInternal(collection)) return [];
    const results = await Promise.all(ids.map((id) => this.get<T>(collection, id)));
    return results.filter((d) => d !== null) as T[];
  }

  async getAll<T extends BaseDocument>(collection: string): Promise<T[]> {
    if (this.isInternal(collection)) return [];
    // Pull is paged; drain every page in-Worker so the full collection
    // materializes (the HTTP path drains on the client instead).
    const all: T[] = [];
    let cursor = 0;
    for (;;) {
      const page = await pullDocumentsSince(this.opts.env, collection, cursor);
      for (const r of page.documents) all.push(r.data as T);
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    return all;
  }

  async put<T extends BaseDocument>(collection: string, doc: T): Promise<void> {
    await this.putMany(collection, [doc]);
  }

  async putMany<T extends BaseDocument>(collection: string, docs: T[]): Promise<void> {
    if (this.isInternal(collection)) return;
    const outcome = await pushDocuments(
      this.opts.env,
      docs.map((doc) => ({ id: doc.id, collection, updatedAt: doc.updatedAt, data: doc })),
      { hooks: this.opts.hooks, waitUntil: this.opts.waitUntil }
    );
    if (!outcome.ok) {
      throw new Error(`Push failed (${outcome.code}): ${outcome.error}`);
    }
  }

  async delete(_collection: string, _id: string): Promise<void> {
    // Store.delete writes tombstones via put; hard deletes never reach an
    // adapter in normal use.
    throw new Error('D1Adapter does not support hard delete');
  }

  async wipe(): Promise<void> {
    await wipeAllDocumentsViaApi(this.opts.env);
  }

  async listCollections(): Promise<string[]> {
    return [...this.opts.collections];
  }
}
