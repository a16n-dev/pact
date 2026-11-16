import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Text as YText } from 'yjs';
import { Store } from '../src/store';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { defineCollection } from '../src/collection';
import { CONFIG, configRecord } from '../src/store/internal';
import type { StoredRecord } from '../src/record';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import type { DocCipher } from '../src/crypto/types';
import { registerTextField, type TextEngine } from '../src/text/engine';
import { yjsTextEngine } from '../src/yjs';
import { FakeServer } from './fakeServer';
import { signIn } from './signIn';

// Yjs orders concurrent inserts by client id, which it draws at random.
// Numbering them per run makes a seed replay the same merges.
let nextClientId = 1;
const numberedYjs: TextEngine<YText> = {
  open(fields, state) {
    const doc = yjsTextEngine.open(fields, state);
    doc.handle(fields[0]!).doc!.clientID = nextClientId++;
    return doc;
  },
  seed: (fields, values, seed) => yjsTextEngine.seed(fields, values, seed),
};

function numberedText(): z.ZodString {
  const schema = z.string();
  registerTextField(schema, numberedYjs);
  return schema;
}

const notes = defineCollection({
  name: 'notes',
  key: 'n',
  idPrefix: 'nt',
  merge: 'field',
  schema: (base) => base.extend({ title: z.string(), tags: z.array(z.string()).default([]) }),
});

const docs = defineCollection({
  name: 'docs',
  idPrefix: 'd',
  merge: 'field',
  schema: (base) => base.extend({ body: numberedText() }),
});

const collections = [notes, docs] as const;

type TestStore = Store<typeof collections>;

const NOTE_IDS = ['nt-1', 'nt-2'] as const;
const DOC_IDS = ['d-1', 'd-2'] as const;
const DEVICE_LABELS = ['A', 'B', 'C'];
const OP_SPACING_MS = 1_000;
const MAX_SETTLE_ROUNDS = 6;

class NetworkDown extends TypeError {
  constructor() {
    super('fetch failed');
  }
}

// A request the harness did not ask for, such as the drain a write kicks off
// in the background. It never reaches the server, so only explicit steps
// move data and a seed replays the same way.
class Unrequested extends TypeError {
  constructor() {
    super('fetch failed');
  }
}

type RequestKind = 'push' | 'pull';
type Fault = 'pushFails' | 'pushLost' | 'pullFails';
type Via = 'handle' | 'updateText' | 'write';

type Hold = { kind: RequestKind; entered: () => void; released: Promise<void> };

type Device = {
  label: string;
  adapter: InMemoryAdapter;
  store: TestStore;
  token: string;
  allowed: RequestKind | null;
  offline: boolean;
  fault: Fault | null;
  hold: Hold | null;
};

type NoteId = (typeof NOTE_IDS)[number];
type DocId = (typeof DOC_IDS)[number];

type Write =
  | { op: 'upsertNote' | 'setTitle' | 'setTags'; id: NoteId }
  | { op: 'delete'; collection: 'notes'; id: NoteId }
  | { op: 'delete'; collection: 'docs'; id: DocId }
  | { op: 'createDoc'; id: DocId; length: number }
  | { op: 'insert' | 'remove'; id: DocId; via: Via; at: number; length: number };

type Op =
  | ({ d: number } & Write)
  | { d: number; op: 'compact'; id: string }
  | { d: number; op: 'sync' | 'pull' | 'drain' | 'offline' | 'online' | 'reload' }
  | { d: number; op: 'fault'; fault: Fault }
  | { d: number; op: 'during'; sync: RequestKind; write: Write };

function describeWrite(w: Write): string {
  switch (w.op) {
    case 'delete':
      return `delete(${w.collection}/${w.id})`;
    case 'createDoc':
      return `createDoc(${w.id} +${w.length})`;
    case 'insert':
      return `insert(${w.id} @${w.at / 1000} +${w.length} via ${w.via})`;
    case 'remove':
      return `remove(${w.id} @${w.at / 1000} -${w.length} via ${w.via})`;
    default:
      return `${w.op}(${w.id})`;
  }
}

function describeOp(o: Op): string {
  const who = DEVICE_LABELS[o.d];
  switch (o.op) {
    case 'compact':
      return `${who}.compact(${o.id})`;
    case 'sync':
    case 'pull':
    case 'drain':
    case 'offline':
    case 'online':
    case 'reload':
      return `${who}.${o.op}()`;
    case 'fault':
      return `${who}.fault(${o.fault})`;
    case 'during':
      return `${who}.${describeWrite(o.write)} during ${o.sync}`;
    default:
      return `${who}.${describeWrite(o)}`;
  }
}

const noteId = fc.constantFrom(...NOTE_IDS);
const docId = fc.constantFrom(...DOC_IDS);
const chunk = fc.integer({ min: 1, max: 3 });

const writeArb: fc.Arbitrary<Write> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constantFrom('upsertNote' as const, 'setTitle' as const, 'setTags' as const),
      id: noteId,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.oneof(
      fc.record({
        op: fc.constant('delete' as const),
        collection: fc.constant('notes' as const),
        id: noteId,
      }),
      fc.record({
        op: fc.constant('delete' as const),
        collection: fc.constant('docs' as const),
        id: docId,
      })
    ),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant('createDoc' as const), id: docId, length: chunk }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      op: fc.constantFrom('insert' as const, 'remove' as const),
      id: docId,
      via: fc.constantFrom<Via>('handle', 'updateText', 'write'),
      at: fc.nat(1000),
      length: chunk,
    }),
  }
);

function opArb(deviceCount: number): fc.Arbitrary<Op> {
  const device = fc.nat(deviceCount - 1);
  return fc
    .oneof(
      { weight: 12, arbitrary: fc.tuple(device, writeArb).map(([d, w]): Op => ({ d, ...w })) },
      {
        weight: 1,
        // TODO(alex): only device A compacts. When two devices compact the
        // same text before either sees the other's compaction, edits only the
        // losing generation holds are lost (pinned under 'text compaction').
        // Fixing that needs the server to know text generations.
        arbitrary: fc.record({ d: fc.constant(0), op: fc.constant('compact' as const), id: docId }),
      },
      {
        weight: 6,
        arbitrary: fc.record({
          d: device,
          op: fc.constantFrom('sync' as const, 'pull' as const, 'drain' as const),
        }),
      },
      {
        weight: 2,
        arbitrary: fc.record({
          d: device,
          op: fc.constant('during' as const),
          sync: fc.constantFrom<RequestKind>('push', 'pull'),
          write: writeArb,
        }),
      },
      {
        weight: 2,
        arbitrary: fc.record({
          d: device,
          op: fc.constantFrom('offline' as const, 'online' as const),
        }),
      },
      { weight: 1, arbitrary: fc.record({ d: device, op: fc.constant('reload' as const) }) },
      {
        weight: 2,
        arbitrary: fc.record({
          d: device,
          op: fc.constant('fault' as const),
          fault: fc.constantFrom<Fault>('pushFails', 'pushLost', 'pullFails'),
        }),
      }
    )
    .map((o) => Object.assign(o, { [fc.toStringMethod]: () => describeOp(o) }));
}

const runArb = fc.integer({ min: 2, max: 3 }).chain((devices) =>
  fc.record({
    devices: fc.constant(devices),
    ops: fc.array(opArb(devices), { minLength: 1, maxLength: 40, size: 'max' }),
  })
);

function routedFetch(server: FakeServer, devices: Device[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
    const from = devices.find((d) => d.token === bearer);
    if (!from) return server.fetch(url, init);
    const path = new URL(url).pathname;
    const kind = path === '/sync/push' ? 'push' : path === '/sync/pull' ? 'pull' : null;
    if (kind === null || kind !== from.allowed) throw new Unrequested();
    if (from.offline) throw new NetworkDown();
    const hold = from.hold;
    if (hold?.kind === kind) {
      from.hold = null;
      hold.entered();
      await hold.released;
    }
    const fault = from.fault;
    if (fault && (fault === 'pullFails') === (kind === 'pull')) {
      from.fault = null;
      if (fault === 'pushLost') await server.fetch(url, init);
      throw new NetworkDown();
    }
    return server.fetch(url, init);
  };
}

// Never opens, so realtime never pulls or drains on its own schedule.
class SilentSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

function openStore(adapter: InMemoryAdapter, cipher: DocCipher | undefined): Promise<TestStore> {
  return Store.create({
    adapter,
    collections,
    encryption: cipher ? { cipher } : undefined,
    textPushDelayMs: 3_600_000,
  });
}

// Waits out background syncs while the network is closed to them. The second
// drain catches one queued by a text rebase during the pull.
async function quiesce(store: TestStore): Promise<void> {
  await store.sync.drain().catch(() => {});
  await store.sync.pull().catch(() => {});
  await store.sync.drain().catch(() => {});
}

async function allowing(dev: Device, kind: RequestKind): Promise<void> {
  dev.allowed = kind;
  try {
    await (kind === 'push' ? dev.store.sync.drain() : dev.store.sync.pull());
  } catch (err) {
    if (!(err instanceof NetworkDown)) throw err;
  } finally {
    dev.allowed = null;
  }
  if (kind === 'push' && !dev.offline) await realtimePull(dev);
}

// TODO(alex): stands in for the pull realtime makes when the server
// announces a device's own push, and never fails. Without it the generator
// finds the loss pinned under 'text compaction': an edit pushed over a
// compaction its device had not seen, then hidden by the compacting device
// pushing again before the editor pulls. Closing that needs the server to
// know text generations.
async function realtimePull(dev: Device): Promise<void> {
  const fault = dev.fault;
  dev.fault = null;
  await quiesce(dev.store);
  dev.allowed = 'pull';
  try {
    await dev.store.sync.pull();
  } finally {
    dev.allowed = null;
    dev.fault = fault;
  }
}

async function snapshot(store: TestStore) {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
  return {
    notes: (await store.collection('notes').list({ includeDeleted: true })).sort(byId),
    docs: (await store.collection('docs').list({ includeDeleted: true })).sort(byId),
  };
}

function nextChange(store: TestStore, collection: string): Promise<void> {
  return new Promise((resolve) => {
    const off = store.on('change', (changed) => {
      if (changed !== collection) return;
      off();
      resolve();
    });
  });
}

class Run {
  private readonly server = new FakeServer();
  private readonly devices: Device[] = [];
  private readonly cipher: DocCipher | undefined;
  // Last value written to each field in op order, which is HLC order: every
  // op runs at its own wall time and the clocks share the faked Date.
  private readonly fields = new Map<string, unknown>();
  private readonly inserted = new Map<string, Set<string>>();
  private readonly deleted = new Map<string, Set<string>>();
  private nextChar = 0;

  constructor(cipher: DocCipher | undefined) {
    this.cipher = cipher;
  }

  async start(deviceCount: number): Promise<void> {
    nextClientId = 1;
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    this.server.createApp('app');
    this.server.createUser('alice', 'pw');
    vi.stubGlobal('fetch', routedFetch(this.server, this.devices));
    vi.stubGlobal('WebSocket', SilentSocket);
    for (const label of DEVICE_LABELS.slice(0, deviceCount)) {
      const adapter = new InMemoryAdapter();
      await adapter.put(CONFIG, 'node', configRecord('node', { node: `device${label}` }));
      const store = await openStore(adapter, this.cipher);
      await signIn(store, this.server, label);
      const token = (await store.sync.credentials())!.token;
      this.devices.push({
        label,
        adapter,
        store,
        token,
        allowed: null,
        offline: false,
        fault: null,
        hold: null,
      });
    }
  }

  dispose(): void {
    for (const dev of this.devices) dev.store.dispose();
  }

  async apply(o: Op, step: number): Promise<void> {
    const dev = this.devices[o.d]!;
    vi.setSystemTime(Date.now() + OP_SPACING_MS);
    await this.perform(dev, o, step);
    await quiesce(dev.store);
  }

  private async perform(dev: Device, o: Op, step: number): Promise<void> {
    switch (o.op) {
      case 'compact': {
        const coll = dev.store.collection('docs');
        if (!(await coll.get(o.id, { includeDeleted: true }))) return;
        dev.allowed = 'pull';
        try {
          await coll.compactText(o.id);
        } catch (err) {
          if (!(err instanceof NetworkDown)) throw err;
        } finally {
          dev.allowed = null;
        }
        return;
      }
      case 'sync':
        await allowing(dev, 'push');
        await quiesce(dev.store);
        await allowing(dev, 'pull');
        return;
      case 'drain':
        await allowing(dev, 'push');
        return;
      case 'pull':
        await allowing(dev, 'pull');
        return;
      case 'during':
        await this.during(dev, o.sync, o.write, step);
        return;
      case 'offline':
        dev.offline = true;
        return;
      case 'online':
        dev.offline = false;
        return;
      case 'fault':
        dev.fault = o.fault;
        return;
      case 'reload': {
        const before = await snapshot(dev.store);
        const pending = await dev.store.sync.pending();
        dev.store.dispose();
        dev.store = await openStore(dev.adapter, this.cipher);
        expect(await snapshot(dev.store), 'state survives a reload').toEqual(before);
        expect(await dev.store.sync.pending(), 'outbox survives a reload').toBe(pending);
        return;
      }
      default:
        await this.write(dev.store, o, step);
    }
  }

  // Makes the write while the sync's first request is in flight, or after
  // the sync when it sends none.
  private async during(dev: Device, kind: RequestKind, w: Write, step: number): Promise<void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const inFlight = new Promise<void>((entered) => {
      dev.hold = { kind, entered, released };
    });
    const done = allowing(dev, kind);
    await Promise.race([inFlight, done]);
    try {
      await this.write(dev.store, w, step);
    } finally {
      dev.hold = null;
      release();
    }
    await done;
  }

  private async write(store: TestStore, o: Write, step: number): Promise<void> {
    switch (o.op) {
      case 'upsertNote':
      case 'setTitle':
      case 'setTags': {
        const coll = store.collection('notes');
        const before = await coll.get(o.id, { includeDeleted: true });
        const title = `t${step}`;
        const tags = [`g${step}`];
        if (o.op === 'upsertNote') {
          await coll.upsert({ id: o.id, title, tags });
          this.expectField('notes', o.id, 'title', title);
          this.expectField('notes', o.id, 'tags', tags);
          if (!before || before.deletedAt) this.expectField('notes', o.id, 'deleted', false);
          return;
        }
        if (!before) return;
        if (o.op === 'setTitle') {
          await coll.update(o.id, { title });
          this.expectField('notes', o.id, 'title', title);
        } else {
          await coll.update(o.id, { tags });
          this.expectField('notes', o.id, 'tags', tags);
        }
        return;
      }
      case 'delete': {
        const coll = store.collection(o.collection);
        if (!(await coll.get(o.id, { includeDeleted: true }))) return;
        await coll.delete(o.id);
        this.expectField(o.collection, o.id, 'deleted', true);
        return;
      }
      case 'createDoc': {
        const coll = store.collection('docs');
        const before = await coll.get(o.id, { includeDeleted: true });
        if (before && !before.deletedAt) return;
        const body = this.fresh(o.length);
        await coll.getOrCreate({ id: o.id, body });
        if (before) this.track(this.deleted, o.id, before.body);
        this.track(this.inserted, o.id, body);
        this.expectField('docs', o.id, 'deleted', false);
        expect((await coll.get(o.id))?.body).toBe(body);
        return;
      }
      case 'insert':
      case 'remove': {
        const coll = store.collection('docs');
        const before = await coll.get(o.id, { includeDeleted: true });
        if (!before) return;
        const text = before.body;
        let at: number;
        let removed = 0;
        let added = '';
        if (o.op === 'insert') {
          at = Math.round((o.at * text.length) / 1000);
          added = this.fresh(o.length);
          this.track(this.inserted, o.id, added);
        } else {
          if (text.length === 0) return;
          at = Math.min(text.length - 1, Math.floor((o.at * text.length) / 1000));
          removed = Math.min(o.length, text.length - at);
          this.track(this.deleted, o.id, text.slice(at, at + removed));
        }
        const next = text.slice(0, at) + added + text.slice(at + removed);
        if (o.via === 'handle') {
          const handle = await coll.text(o.id, 'body');
          expect(handle.toString()).toBe(text);
          const persisted = nextChange(store, 'docs');
          if (removed > 0) handle.delete(at, removed);
          else handle.insert(at, added);
          await persisted;
        } else if (o.via === 'updateText') {
          await coll.updateText(o.id, 'body', { base: text, next });
        } else {
          await coll.update(o.id, { body: next });
        }
        expect((await coll.get(o.id, { includeDeleted: true }))?.body).toBe(next);
        return;
      }
    }
  }

  private expectField(collection: string, id: string, field: string, value: unknown): void {
    this.fields.set(`${collection}/${id}/${field}`, value);
  }

  // Every inserted character is unique in the run, so a string diff cannot
  // align one insert with another and text checks reduce to set membership.
  private fresh(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(0x4e00 + this.nextChar++);
    return out;
  }

  private track(map: Map<string, Set<string>>, id: string, chars: string): void {
    const set = map.get(id) ?? new Set<string>();
    for (const char of chars) set.add(char);
    map.set(id, set);
  }

  async settle(): Promise<Array<Awaited<ReturnType<typeof snapshot>>>> {
    for (const dev of this.devices) {
      dev.offline = false;
      dev.fault = null;
    }
    let previous = '';
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      for (const dev of this.devices) {
        vi.setSystemTime(Date.now() + OP_SPACING_MS);
        dev.allowed = 'push';
        await dev.store.sync.drain();
        await quiesce(dev.store);
        dev.allowed = 'pull';
        await dev.store.sync.pull();
        dev.allowed = null;
        await quiesce(dev.store);
      }
      const states = await Promise.all(this.devices.map((dev) => snapshot(dev.store)));
      const pending = await Promise.all(this.devices.map((dev) => dev.store.sync.pending()));
      const key = JSON.stringify({ states, pending });
      if (key === previous && pending.every((n) => n === 0)) return states;
      previous = key;
    }
    throw new Error(`Devices did not settle within ${MAX_SETTLE_ROUNDS} rounds`);
  }

  async check(): Promise<void> {
    const states = await this.settle();
    for (const [i, state] of states.entries()) {
      expect(state, `device ${this.devices[i]!.label} converges with A`).toEqual(states[0]);
    }
    const [{ notes: finalNotes, docs: finalDocs }] = states as [(typeof states)[0]];
    for (const [key, value] of this.fields) {
      const [collection, id, field] = key.split('/') as [string, string, string];
      const doc = (collection === 'notes' ? finalNotes : finalDocs).find((d) => d.id === id);
      expect(doc, `${collection}/${id} exists`).toBeDefined();
      const actual =
        field === 'deleted' ? doc!.deletedAt !== null : doc![field as keyof typeof doc];
      expect(actual, `last write wins on ${key}`).toEqual(value);
    }
    for (const id of DOC_IDS) {
      const body = finalDocs.find((d) => d.id === id)?.body ?? '';
      const deleted = this.deleted.get(id) ?? new Set();
      const kept = [...(this.inserted.get(id) ?? [])].filter((char) => !deleted.has(char));
      const missing = kept.filter((char) => !body.includes(char));
      expect(missing, `inserts kept in docs/${id}`).toEqual([]);
      expect(body.length, `no duplicated text in docs/${id}`).toBe(new Set(body).size);
    }
  }
}

let sharedCipher: DocCipher;

beforeAll(async () => {
  sharedCipher = createWebCryptoCipher(await deriveEncryptionKey('pw', 'salt', 1_000));
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([
  { name: 'unencrypted', encrypted: false },
  { name: 'with a shared key', encrypted: true },
])('convergence ($name)', ({ encrypted }) => {
  it('converges after random operations and network faults', async () => {
    await fc.assert(
      fc.asyncProperty(runArb, async ({ devices, ops }) => {
        const run = new Run(encrypted ? sharedCipher : undefined);
        try {
          await run.start(devices);
          for (const [step, op] of ops.entries()) await run.apply(op, step);
          await run.check();
        } finally {
          run.dispose();
        }
      }),
      { numRuns: 1_500 }
    );
  }, 60_000);
});

describe('text compaction', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    server.createApp('app');
    server.createUser('alice', 'pw');
    vi.stubGlobal('fetch', server.fetch);
    vi.stubGlobal('WebSocket', SilentSocket);
  });

  async function device(label: string, adapter = new InMemoryAdapter()): Promise<TestStore> {
    const store = await openStore(adapter, undefined);
    await signIn(store, server, label);
    return store;
  }

  async function bodyOf(store: TestStore): Promise<string | undefined> {
    return (await store.collection('docs').get('d-1'))?.body;
  }

  it('keeps a text edit that reaches the server after a compaction of the same text', async () => {
    const a = await device('A');
    const b = await device('B');
    await a.collection('docs').create({ id: 'd-1', body: 'one' });
    await a.sync.drain();
    await b.sync.pull();
    await b.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await a.collection('docs').compactText('d-1');
    await a.sync.drain();
    await b.sync.drain();
    await b.sync.pull();
    await b.sync.drain();
    await a.sync.pull();
    expect((await a.collection('docs').get('d-1'))?.body).toBe('one two');
    expect((await b.collection('docs').get('d-1'))?.body).toBe('one two');
  });

  it('rebases queued text onto a compaction without repeating edits merged from other devices', async () => {
    const a = await device('A');
    const b = await device('B');
    await a.collection('docs').create({ id: 'd-1', body: 'one' });
    await a.sync.drain();
    await b.sync.pull();
    await b.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await a.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'one three' });
    await a.sync.drain();
    await b.sync.pull();
    await a.collection('docs').compactText('d-1');
    await a.sync.drain();
    await b.sync.pull();
    const body = (await b.collection('docs').get('d-1'))!.body;
    expect(body.split(' ').sort()).toEqual(['one', 'three', 'two']);
  });

  // The editing device sees only the compacting device's latest version,
  // which no longer shows that the compaction reached the server first.
  it.fails(
    'keeps a text edit pushed over a compaction once the compacting device pushes again',
    async () => {
      const a = await device('A');
      const b = await device('B');
      await a.collection('docs').create({ id: 'd-1', body: 'one' });
      await a.sync.drain();
      await b.sync.pull();
      await a.collection('docs').compactText('d-1');
      await a.sync.drain();
      await a.sync.pull();
      await b.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'one two' });
      await b.sync.drain();
      await a.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'zero one' });
      await a.sync.drain();
      await b.sync.pull();
      await b.sync.drain();
      await a.sync.pull();
      expect(await bodyOf(a)).toBe('zero one two');
      expect(await bodyOf(b)).toBe('zero one two');
    }
  );

  // Each device compacts before the other's compaction reaches it. Edits made
  // before the losing compaction were only ever pushed inside it.
  it.fails('keeps the edits of a compaction that loses to a concurrent one', async () => {
    const adapters = [new InMemoryAdapter(), new InMemoryAdapter()] as const;
    const a = await device('A', adapters[0]);
    const b = await device('B', adapters[1]);
    await a.collection('docs').create({ id: 'd-1', body: 'one' });
    await a.sync.drain();
    await b.sync.pull();
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (input.endsWith('/sync/push')) throw new NetworkDown();
      return server.fetch(input, init);
    });
    await a.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'one two' });
    await a.collection('docs').compactText('d-1');
    await b.collection('docs').updateText('d-1', 'body', { base: 'one', next: 'one three' });
    await b.collection('docs').compactText('d-1');
    vi.stubGlobal('fetch', server.fetch);
    const seeds = await Promise.all(
      adapters.map(
        async (adapter) => ((await adapter.get('docs', 'd-1')) as StoredRecord).textGeneration!.seed
      )
    );
    const [loser, winner] = seeds[0]! < seeds[1]! ? [a, b] : [b, a];
    await loser.sync.drain();
    await winner.sync.drain();
    await loser.sync.pull();
    await winner.sync.pull();
    await loser.sync.drain();
    await winner.sync.pull();
    expect((await bodyOf(winner))?.split(' ').sort()).toEqual(['one', 'three', 'two']);
  });
});
