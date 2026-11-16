import { z } from 'zod';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import type { BackupManifest } from '../src/backup/archive';
import type { BlobAdapter } from '../src/blobs/blobAdapter';
import { defineCollection } from '../src/collection';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import type { DocCipher } from '../src/crypto/types';
import { defineCollectionMigrations } from '../src/migrator';
import type { AdapterRecord, StoredRecord } from '../src/record';
import type { Store } from '../src/store';
import type { Registration } from '../src/store/namespaces';
import type { WireDocument } from '../src/sync/http';
import { yText } from '../src/yjs';
import type { FakeServer } from './fakeServer';

export const notes = defineCollection({
  name: 'notes',
  key: 'n',
  idPrefix: 'nt',
  merge: 'field',
  migrations: defineCollectionMigrations({
    current: 3,
    migrations: [
      { from: 1, to: 2, up: ({ name, ...rest }) => ({ ...rest, title: name }) },
      { from: 2, to: 3, up: (fields) => ({ ...fields, tags: [] }) },
    ],
  }),
  schema: (base) => base.extend({ title: z.string(), tags: z.array(z.string()) }),
});

export const docs = defineCollection({
  name: 'docs',
  idPrefix: 'd',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), body: yText() }),
});

const settings = defineCollection({
  name: 'settings',
  idPrefix: 'st',
  ids: 'slug',
  merge: 'document',
  schema: (base) => base.extend({ theme: z.string(), fontSizePx: z.number() }),
});

const prefs = defineCollection({
  name: 'prefs',
  idPrefix: 'p',
  merge: 'field',
  synced: false,
  schema: (base) => base.extend({ theme: z.string() }),
});

export const fixtureCollections = [notes, docs, settings, prefs] as const;

export const APP_ID = 'app';
const USER = { username: 'alice', password: 'pw' };
const REDIRECT_URI = 'https://app.test/callback';

export type KeyInput = { password: string; salt: string; iterations: number };

export async function cipherFor(key: KeyInput): Promise<DocCipher> {
  return createWebCryptoCipher(await deriveEncryptionKey(key.password, key.salt, key.iterations));
}

type AdapterDump = Record<string, Record<string, AdapterRecord>>;

export async function dumpAdapter(adapter: InMemoryAdapter): Promise<AdapterDump> {
  const dump: AdapterDump = {};
  for (const collection of await adapter.listCollections()) {
    const entries = await adapter.getAll(collection);
    if (entries.length === 0) continue;
    dump[collection] = Object.fromEntries(entries.map(({ id, record }) => [id, record]));
  }
  return dump;
}

export async function loadAdapter(dump: AdapterDump): Promise<InMemoryAdapter> {
  const adapter = new InMemoryAdapter();
  for (const [collection, entries] of Object.entries(dump)) {
    for (const [id, record] of Object.entries(entries)) await adapter.put(collection, id, record);
  }
  return adapter;
}

export class MemoryBlobAdapter implements BlobAdapter {
  private readonly blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async read(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash)?.bytes ?? null;
  }

  async mimeType(hash: string): Promise<string | null> {
    return this.blobs.get(hash)?.mimeType ?? null;
  }

  async write(hash: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    this.blobs.set(hash, { bytes, mimeType });
  }

  async delete(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }

  async list(): Promise<string[]> {
    return Array.from(this.blobs.keys());
  }

  uriFor(): string | null {
    return null;
  }
}

export function setUpServer(server: FakeServer): void {
  server.createApp(APP_ID, [REDIRECT_URI]);
  server.createUser(USER.username, USER.password);
}

export async function signIn(store: Store<any>, server: FakeServer): Promise<void> {
  const begun = await store.sync.beginSignIn({
    url: server.origin,
    appId: APP_ID,
    deviceName: 'Fixture device',
    redirectUri: REDIRECT_URI,
  });
  const redirect = server.authorize(begun.authorizeUrl, USER);
  if ('error' in redirect) throw new Error(redirect.error);
  const result = await store.sync.completeSignIn(redirect);
  if (!result.ok) throw new Error(`Sign-in failed: ${result.reason}`);
}

type Documents = Record<string, Array<Record<string, unknown>>>;

export async function readDocuments(store: Store<any>): Promise<Documents> {
  const out: Documents = {};
  for (const def of fixtureCollections) {
    const list = await store.collection(def.name).list({ includeDeleted: true });
    out[def.name] = JSON.parse(JSON.stringify(list.sort((a, b) => (a.id < b.id ? -1 : 1))));
  }
  return out;
}

export type WireFixture = { collection: string; id: string; wire: string; record: StoredRecord };

export type EnvelopeFixture = {
  key: KeyInput;
  rawKey: string;
  keyId: string;
  collection: string;
  id: string;
  envelope: string;
  record: StoredRecord;
};

export type HlcFixture = {
  sorted: Array<{ encoded: string; wallMs: number; counter: number; node: string; iso: string }>;
};

export type BackupFixture = {
  archive: string;
  manifest: BackupManifest;
  blobs: Array<{ hash: string; mimeType: string; bytes: string }>;
  documents: Documents;
};

export type TextFixture = {
  collection: string;
  storageKey: string;
  fields: string[];
  records: Array<{
    id: string;
    compacted: boolean;
    record: StoredRecord;
    text: Record<string, string>;
  }>;
};

export type MigrationFixture = {
  collection: string;
  storageKey: string;
  id: string;
  record: StoredRecord;
  currentVersion: number;
  migratedFields: Record<string, unknown>;
  document: Record<string, unknown>;
};

export type SnapshotFixture = {
  adapter: AdapterDump;
  registration: Registration;
  credentials: { url: string; token: string };
  lastSyncedAt: string;
  cursor: number;
  views: Array<{ key: KeyInput | null; documents: Documents }>;
  pending: WireDocument[];
};
