import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { unpackBackup } from '../src/backup/archive';
import { clockToIso, decodeHlc, encodeHlc } from '../src/clock';
import { toBase64 } from '../src/crypto/base64';
import { encryptedCodec, toWire } from '../src/crypto/codec';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import type { DocCipher } from '../src/crypto/types';
import { Migrator } from '../src/migrator';
import { greatestClock, isSealedRecord, type StoredRecord } from '../src/record';
import { Store } from '../src/store';
import { CONFIG, OUTBOX, configRecord, type OutboxEntry } from '../src/store/internal';
import { FakeServer } from '../tests/fakeServer';
import {
  MemoryBlobAdapter,
  cipherFor,
  docs,
  dumpAdapter,
  fixtureCollections,
  notes,
  readDocuments,
  setUpServer,
  signIn,
  type BackupFixture,
  type EnvelopeFixture,
  type HlcFixture,
  type KeyInput,
  type MigrationFixture,
  type SnapshotFixture,
  type TextFixture,
  type WireFixture,
} from '../tests/fixtureSupport';

const version = process.argv[2];
if (!version || !/^v\d+$/.test(version)) {
  console.error('Usage: pnpm fixtures:generate <version>, e.g. v2');
  process.exit(1);
}
const outDir = join(import.meta.dirname, '..', 'tests', 'fixtures', version);
if (existsSync(outDir)) {
  console.error(`${outDir} already exists. Fixtures are frozen: pick a new version.`);
  process.exit(1);
}

const START_MS = Date.UTC(2026, 0, 1);
const STEP_MS = 1_000;
let nowMs = START_MS;

// Every wall-clock read (HLCs, `lastSyncedAt`, a backup's `createdAt`) sees
// this pinned time, so the plaintext output is the same on every run.
const RealDate = Date;
class PinnedDate extends RealDate {
  constructor(value?: string | number | Date) {
    super(value === undefined ? nowMs : value);
  }

  static override now(): number {
    return nowMs;
  }
}
globalThis.Date = PinnedDate as DateConstructor;

function tick(): void {
  nowMs += STEP_MS;
}

const KEY: KeyInput = { password: 'fixture password', salt: 'fixture salt', iterations: 1_000 };
const SECOND_KEY: KeyInput = {
  password: 'second password',
  salt: 'fixture salt',
  iterations: 1_000,
};
const NODE = 'fixtureNode1';

const fixtures: Record<string, unknown> = {};

async function wireFixtures(): Promise<void> {
  const record: StoredRecord = {
    schemaVersion: 3,
    fields: {
      id: 'nt-wire',
      createdAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      title: 'On the wire',
      tags: ['plain', 'üñî'],
    },
    clocks: {
      title: '1767225600000-0000-fixtureNode1',
      tags: '1767225601000-0003-fixtureNode1',
      deletedAt: '1767225600000-0000-fixtureNode1',
    },
  };
  const plain: WireFixture = { collection: 'n', id: 'nt-wire', wire: toWire(record), record };
  fixtures['wire-plain'] = plain;

  const rawKey = await deriveEncryptionKey(KEY.password, KEY.salt, KEY.iterations);
  const cipher = createWebCryptoCipher(rawKey);
  const keyId = await cipher.keyId();
  const collection = `n@${keyId}`;
  const sealed = await encryptedCodec(cipher).encode(collection, 'nt-wire', record);
  if (!isSealedRecord(sealed)) throw new Error('Expected a sealed record');
  const encrypted: EnvelopeFixture = {
    key: KEY,
    rawKey: toBase64(rawKey),
    keyId,
    collection,
    id: 'nt-wire',
    envelope: sealed.enc,
    record,
  };
  fixtures['wire-encrypted'] = encrypted;
}

function hlcFixture(): void {
  const clocks = [
    { wallMs: 1767225600000, counter: 0, node: 'b' },
    { wallMs: 1767225600000, counter: 0, node: 'a' },
    { wallMs: 1767225600000, counter: 10, node: 'a' },
    { wallMs: 1767225600000, counter: 9, node: 'z' },
    { wallMs: 1767225600000, counter: 0xffff, node: 'a' },
    { wallMs: 1767225600001, counter: 0, node: 'a' },
    { wallMs: 999, counter: 1, node: 'node-with-dashes' },
    { wallMs: 0, counter: 0, node: 'a' },
  ];
  const encoded = clocks.map(encodeHlc).sort();
  const fixture: HlcFixture = {
    sorted: encoded.map((value) => ({
      encoded: value,
      ...decodeHlc(value),
      iso: clockToIso(value),
    })),
  };
  fixtures.hlc = fixture;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function plainStore(adapter = new InMemoryAdapter(), blobs?: MemoryBlobAdapter) {
  await adapter.put(CONFIG, 'node', configRecord('node', { node: NODE }));
  return Store.create({ adapter, collections: fixtureCollections, blobs });
}

async function backupFixture(): Promise<void> {
  const blobs = new MemoryBlobAdapter();
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => (i * 7) % 256);
  const hash = await sha256Hex(bytes);
  await blobs.write(hash, bytes, 'image/png');
  const store = await plainStore(new InMemoryAdapter(), blobs);
  tick();
  await store.collection('notes').create({ id: 'nt-backup', title: 'Backed up', tags: ['x'] });
  tick();
  await store.collection('notes').create({ id: 'nt-deleted', title: 'Deleted', tags: [] });
  tick();
  await store.collection('notes').delete('nt-deleted');
  tick();
  await store.collection('docs').create({ id: 'd-backup', title: 'Doc', body: 'Archived text' });
  tick();
  await store.collection('settings').create({ id: 'st-main', theme: 'dark', fontSizePx: 14 });
  tick();
  await store.collection('prefs').create({ id: 'p-local', theme: 'light' });
  const archive = await store.backup.create();
  const { manifest } = unpackBackup(archive);
  const fixture: BackupFixture = {
    archive: toBase64(archive),
    manifest,
    blobs: [{ hash, mimeType: 'image/png', bytes: toBase64(bytes) }],
    documents: await readDocuments(store),
  };
  store.dispose();
  fixtures.backup = fixture;
}

async function textFixture(): Promise<void> {
  const adapter = new InMemoryAdapter();
  const store = await plainStore(adapter);
  const collection = store.collection('docs');
  for (const id of ['d-edited', 'd-compacted'] as const) {
    tick();
    await collection.create({ id, title: 'Text', body: 'The quick brown fox' });
    tick();
    await collection.update(id, { body: 'The quick brown fox jumps' });
    tick();
    await collection.update(id, { body: 'A quick fox jumps over the lazy dog' });
  }
  tick();
  await collection.compactText('d-compacted');
  const records: TextFixture['records'] = [];
  for (const id of ['d-edited', 'd-compacted'] as const) {
    const record = await adapter.get(docs.key, id);
    if (!record || isSealedRecord(record)) throw new Error('Expected a plain record');
    const doc = await collection.get(id);
    records.push({
      id,
      compacted: record.textGeneration !== undefined,
      record,
      text: { body: doc!.body },
    });
  }
  store.dispose();
  const fixture: TextFixture = {
    collection: docs.name,
    storageKey: docs.key,
    fields: [...docs.textFields],
    records,
  };
  fixtures.text = fixture;
}

async function migrationFixture(): Promise<void> {
  const id = 'nt-old';
  const record: StoredRecord = {
    schemaVersion: 1,
    fields: { id, createdAt: '2025-06-01T00:00:00.000Z', deletedAt: null, name: 'Written by v1' },
    clocks: { name: '1748736000000-0000-oldNode', deletedAt: '1748736000000-0000-oldNode' },
  };
  const migrator = new Migrator({ notes: notes.migrations! });
  const adapter = new InMemoryAdapter();
  await adapter.put(notes.key, id, record);
  const store = await plainStore(adapter);
  const doc = await store.collection('notes').get(id);
  store.dispose();
  const fixture: MigrationFixture = {
    collection: notes.name,
    storageKey: notes.key,
    id,
    record,
    currentVersion: migrator.currentVersion(notes.name),
    migratedFields: migrator.migrate(notes.name, record.schemaVersion, record.fields),
    document: JSON.parse(JSON.stringify(doc)),
  };
  fixtures.migration = fixture;
}

async function pendingPushes(adapter: InMemoryAdapter): Promise<SnapshotFixture['pending']> {
  const pending: SnapshotFixture['pending'] = [];
  for (const { record } of await adapter.getAll(OUTBOX)) {
    if (isSealedRecord(record)) throw new Error('Outbox entries are never sealed');
    const entry = record.fields as unknown as OutboxEntry;
    const stored = await adapter.get(entry.key!, entry.docId);
    if (!stored) throw new Error(`Outbox entry ${entry.key}/${entry.docId} has no record`);
    const hlc = isSealedRecord(stored) ? stored.hlc : greatestClock(stored)!;
    pending.push({ collection: entry.key!, id: entry.docId, hlc, data: toWire(stored) });
  }
  return pending;
}

async function snapshotOf(
  store: Store<typeof fixtureCollections>,
  adapter: InMemoryAdapter,
  views: SnapshotFixture['views']
): Promise<SnapshotFixture> {
  const cursor = await adapter.get(CONFIG, 'cursor');
  if (!cursor || isSealedRecord(cursor)) throw new Error('Expected a sync cursor');
  return {
    adapter: await dumpAdapter(adapter),
    registration: (await store.sync.registration())!,
    credentials: (await store.sync.credentials())!,
    lastSyncedAt: (await store.sync.lastSyncedAt())!.toISOString(),
    cursor: cursor.fields.cursor as number,
    views,
    pending: await pendingPushes(adapter),
  };
}

async function populate(store: Store<typeof fixtureCollections>, server: FakeServer) {
  const notesRef = store.collection('notes');
  const docsRef = store.collection('docs');
  const settingsRef = store.collection('settings');
  tick();
  await notesRef.create({ id: 'nt-kept', title: 'Kept', tags: ['a', 'b'] });
  tick();
  await notesRef.create({ id: 'nt-gone', title: 'Gone', tags: [] });
  tick();
  await notesRef.delete('nt-gone');
  tick();
  await docsRef.create({ id: 'd-letter', title: 'Letter', body: 'Dear diary' });
  tick();
  await docsRef.update('d-letter', { body: 'Dear diary, hello' });
  tick();
  await settingsRef.create({ id: 'st-main', theme: 'dark', fontSizePx: 14 });
  tick();
  await store.collection('prefs').create({ id: 'p-local', theme: 'light' });
  await store.sync.drain();
  await store.sync.pull();

  server.offline = true;
  tick();
  await notesRef.update('nt-kept', { title: 'Kept, renamed offline' });
  tick();
  await notesRef.create({ id: 'nt-offline', title: 'Written offline', tags: [] });
  tick();
  await docsRef.update('d-letter', { body: 'Dear diary, hello again' });
  tick();
  await settingsRef.update('st-main', { fontSizePx: 16 });
  await store.sync.drain().catch(() => {});
}

async function snapshotFixtures(): Promise<void> {
  for (const key of [null, KEY]) {
    const server = new FakeServer();
    setUpServer(server);
    server.mintToken = () => 'pact_fixtureToken';
    globalThis.fetch = server.fetch;
    globalThis.WebSocket = server.WebSocket as unknown as typeof WebSocket;

    const adapter = new InMemoryAdapter();
    await adapter.put(CONFIG, 'node', configRecord('node', { node: NODE }));
    const cipher: DocCipher | null = key ? await cipherFor(key) : null;
    const store = await Store.create({
      adapter,
      collections: fixtureCollections,
      encryption: cipher ? { cipher } : undefined,
    });
    await signIn(store, server);
    await populate(store, server);
    const view = { key, documents: await readDocuments(store) };
    fixtures[key ? 'snapshot-encrypted' : 'snapshot-plain'] = await snapshotOf(store, adapter, [
      view,
    ]);

    if (key) {
      await store.encryption.setKey(await cipherFor(SECOND_KEY));
      tick();
      await store
        .collection('notes')
        .create({ id: 'nt-second', title: 'Under the second key', tags: [] });
      tick();
      await store
        .collection('docs')
        .create({ id: 'd-second', title: 'Second', body: 'Sealed by the second key' });
      await store.sync.drain().catch(() => {});
      fixtures['snapshot-two-lenses'] = await snapshotOf(store, adapter, [
        view,
        { key: SECOND_KEY, documents: await readDocuments(store) },
      ]);
    }
    await store.sync.pull().catch(() => {});
    store.dispose();
  }
}

await wireFixtures();
hlcFixture();
await backupFixture();
await textFixture();
await migrationFixture();
await snapshotFixtures();

mkdirSync(outDir, { recursive: true });
for (const [name, fixture] of Object.entries(fixtures)) {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}
console.log(`Wrote ${Object.keys(fixtures).length} fixtures to ${outDir}`);
process.exit(0);
