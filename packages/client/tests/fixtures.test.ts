// Fixture directories are frozen: never regenerate or edit one. A format
// change adds a new version directory with `pnpm fixtures:generate v<n>`, and
// every older one must keep passing.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { packBackup, unpackBackup } from '../src/backup/archive';
import { clockToIso, compareClocks, decodeHlc, encodeHlc } from '../src/clock';
import { fromBase64, toBase64 } from '../src/crypto/base64';
import { encryptedCodec, plainCodec, toWire } from '../src/crypto/codec';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import { Migrator } from '../src/migrator';
import { StoredRecordSchema } from '../src/record';
import { Store } from '../src/store';
import { yjsTextEngine } from '../src/yjs';
import { FakeServer } from './fakeServer';
import {
  APP_ID,
  MemoryBlobAdapter,
  cipherFor,
  fixtureCollections,
  loadAdapter,
  notes,
  readDocuments,
  setUpServer,
  signIn,
  type BackupFixture,
  type EnvelopeFixture,
  type HlcFixture,
  type MigrationFixture,
  type SnapshotFixture,
  type TextFixture,
  type WireFixture,
} from './fixtureSupport';

const root = join(import.meta.dirname, 'fixtures');
const versions = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
  .map((entry) => entry.name);

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  setUpServer(server);
  vi.stubGlobal('fetch', server.fetch);
  vi.stubGlobal('WebSocket', server.WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('finds at least one fixture version', () => {
  expect(versions).toContain('v1');
});

describe.each(versions)('fixtures %s', (version) => {
  const load = <T>(name: string): T =>
    JSON.parse(readFileSync(join(root, version, `${name}.json`), 'utf8')) as T;

  describe('plain wire record', () => {
    const fixture = load<WireFixture>('wire-plain');

    it('decodes to the expected record', async () => {
      const record = await plainCodec().fromWire(fixture.collection, fixture.id, fixture.wire);
      expect(record).toEqual(fixture.record);
    });

    it('re-encodes byte-identically', () => {
      expect(toWire(fixture.record)).toBe(fixture.wire);
    });
  });

  describe('encrypted envelope', () => {
    const fixture = load<EnvelopeFixture>('wire-encrypted');
    const { key } = fixture;

    it('derives the expected key and key id', async () => {
      const rawKey = await deriveEncryptionKey(key.password, key.salt, key.iterations);
      expect(toBase64(rawKey)).toBe(fixture.rawKey);
      expect(await createWebCryptoCipher(rawKey).keyId()).toBe(fixture.keyId);
    });

    it('opens to the expected record, at rest and from the wire', async () => {
      const codec = encryptedCodec(createWebCryptoCipher(fromBase64(fixture.rawKey)));
      const sealed = { enc: fixture.envelope, hlc: '' };
      expect(await codec.decode(fixture.collection, fixture.id, sealed)).toEqual(fixture.record);
      expect(await codec.fromWire(fixture.collection, fixture.id, fixture.envelope)).toEqual(
        fixture.record
      );
    });

    it('does not open under another key, document id or collection', async () => {
      const codec = encryptedCodec(createWebCryptoCipher(fromBase64(fixture.rawKey)));
      expect(await codec.fromWire(fixture.collection, 'nt-other', fixture.envelope)).toBeNull();
      expect(await codec.fromWire('n', fixture.id, fixture.envelope)).toBeNull();
      const wrong = await deriveEncryptionKey('wrong password', key.salt, key.iterations);
      expect(
        await encryptedCodec(createWebCryptoCipher(wrong)).fromWire(
          fixture.collection,
          fixture.id,
          fixture.envelope
        )
      ).toBeNull();
    });
  });

  describe('hlc', () => {
    const fixture = load<HlcFixture>('hlc');

    it('decodes each clock to its parts and wall time', () => {
      for (const { encoded, iso, ...parts } of fixture.sorted) {
        expect(decodeHlc(encoded)).toEqual(parts);
        expect(clockToIso(encoded)).toBe(iso);
      }
    });

    it('re-encodes byte-identically', () => {
      for (const { encoded, wallMs, counter, node } of fixture.sorted) {
        expect(encodeHlc({ wallMs, counter, node })).toBe(encoded);
      }
    });

    it('sorts in the recorded order', () => {
      const encoded = fixture.sorted.map((clock) => clock.encoded);
      expect([...encoded].reverse().sort(compareClocks)).toEqual(encoded);
    });
  });

  describe('backup archive', () => {
    const fixture = load<BackupFixture>('backup');
    const archive = fromBase64(fixture.archive);

    it('unpacks to the expected manifest and blobs', () => {
      const { manifest, blobs } = unpackBackup(archive);
      expect(manifest).toEqual(fixture.manifest);
      expect(blobs.map((blob) => ({ ...blob, bytes: toBase64(blob.bytes) }))).toEqual(
        fixture.blobs
      );
    });

    it('re-packs byte-identically', () => {
      const { manifest, blobs } = unpackBackup(archive);
      expect(toBase64(packBackup(manifest, blobs))).toBe(fixture.archive);
    });

    it('restores into a store with the expected documents and blobs', async () => {
      const blobs = new MemoryBlobAdapter();
      const store = await Store.create({
        adapter: new InMemoryAdapter(),
        collections: fixtureCollections,
        blobs,
      });
      await store.backup.restore(archive);
      expect(await readDocuments(store)).toEqual(fixture.documents);
      for (const blob of fixture.blobs) {
        expect(toBase64((await blobs.read(blob.hash))!)).toBe(blob.bytes);
        expect(await blobs.mimeType(blob.hash)).toBe(blob.mimeType);
      }
      store.dispose();
    });
  });

  describe('collaborative text', () => {
    const fixture = load<TextFixture>('text');

    it.each(fixture.records)('reads $id as its expected text', async ({ id, record, text }) => {
      expect(StoredRecordSchema.parse(record)).toEqual(record);
      const doc = yjsTextEngine.open(fixture.fields, record.text);
      for (const field of fixture.fields) expect(doc.toString(field)).toBe(text[field]);
      doc.destroy();

      const adapter = new InMemoryAdapter();
      await adapter.put(fixture.storageKey, id, record);
      const store = await Store.create({ adapter, collections: fixtureCollections });
      expect(await store.collection(fixture.collection).get(id)).toMatchObject(text);
      store.dispose();
    });

    it('re-seeds a compacted state byte-identically', () => {
      const compacted = fixture.records.filter((entry) => entry.compacted);
      expect(compacted.length).toBeGreaterThan(0);
      for (const { record, text } of compacted) {
        const values = fixture.fields.map((field) => text[field]!);
        const seeded = yjsTextEngine.seed(fixture.fields, values, record.textGeneration!.seed);
        expect(seeded).toBe(record.text);
      }
    });
  });

  describe('schema migration', () => {
    const fixture = load<MigrationFixture>('migration');

    it('migrates the old record to the expected fields', () => {
      const migrator = new Migrator({ [fixture.collection]: notes.migrations! });
      expect(migrator.currentVersion(fixture.collection)).toBe(fixture.currentVersion);
      expect(
        migrator.migrate(fixture.collection, fixture.record.schemaVersion, fixture.record.fields)
      ).toEqual(fixture.migratedFields);
    });

    it('reads the old record through the store as the expected document', async () => {
      const adapter = new InMemoryAdapter();
      await adapter.put(fixture.storageKey, fixture.id, fixture.record);
      const store = await Store.create({ adapter, collections: fixtureCollections });
      const doc = await store.collection(fixture.collection).get(fixture.id);
      expect(JSON.parse(JSON.stringify(doc))).toEqual(fixture.document);
      store.dispose();
    });
  });

  describe.each(['snapshot-plain', 'snapshot-encrypted', 'snapshot-two-lenses'])('%s', (name) => {
    const fixture = load<SnapshotFixture>(name);

    async function open(key: SnapshotFixture['views'][number]['key']) {
      server.offline = true;
      const cipher = key ? await cipherFor(key) : null;
      const store = await Store.create({
        adapter: await loadAdapter(fixture.adapter),
        collections: fixtureCollections,
        encryption: cipher ? { cipher } : undefined,
      });
      await vi.waitFor(() =>
        expect(server.requests.some((r) => r.path === '/auth/check')).toBe(true)
      );
      return store;
    }

    it.each(fixture.views.map((view) => ({ lens: view.key?.password ?? 'plain', ...view })))(
      'opens the $lens lens and reads the expected documents and session',
      async ({ key, documents }) => {
        const store = await open(key);
        expect(await readDocuments(store)).toEqual(documents);
        expect(await store.sync.registration()).toEqual(fixture.registration);
        expect(await store.sync.credentials()).toEqual(fixture.credentials);
        expect((await store.sync.lastSyncedAt())?.toISOString()).toBe(fixture.lastSyncedAt);
        expect(await store.sync.pending()).toBe(fixture.pending.length);
        await store.sync.pull().catch(() => {});
        store.dispose();
      }
    );

    it('pushes its pending outbox after signing in, pulling from the stored cursor', async () => {
      const store = await open(fixture.views[0]!.key);
      server.offline = false;
      await signIn(store, server);
      await store.sync.drain();
      await store.sync.pull();
      expect(await store.sync.pending()).toBe(0);
      for (const pending of fixture.pending) {
        const versions = server.versionsOf(APP_ID, pending.collection, pending.id);
        expect(
          versions.map(({ collection, id, hlc, data }) => ({ collection, id, hlc, data }))
        ).toEqual([pending]);
      }
      const cursors = server.requests
        .filter((r) => r.path.startsWith('/sync/pull?'))
        .map((r) => new URLSearchParams(r.path.split('?')[1]).get('cursor'));
      expect(cursors[0]).toBe(String(fixture.cursor));
      store.dispose();
    });
  });
});
