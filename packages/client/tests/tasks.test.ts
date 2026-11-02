import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store } from '../src/store';
import { InMemoryAdapter } from '../src/adapters/memoryAdapter';
import { defineCollection } from '../src/collection';
import { defineTask, type TaskDefinition } from '../src/tasks/task';
import { createWebCryptoCipher, deriveEncryptionKey } from '../src/crypto/webCrypto';
import type { DocCipher } from '../src/crypto/types';
import type { TaskState } from '../src/store/namespaces';
import { FakeServer } from './fakeServer';

const slots = defineCollection({
  name: 'slots',
  idPrefix: 'sl',
  merge: 'field',
  schema: (base) => base.extend({ note: z.string(), parsed: z.string().nullable() }),
});

let server: FakeServer;
const stores: Store<any>[] = [];

beforeEach(() => {
  server = new FakeServer();
  server.createApp('app');
  server.createUser('alice', 'pw');
  vi.stubGlobal('fetch', server.fetch);
  vi.stubGlobal('WebSocket', server.WebSocket);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type SlotStore = Store<readonly [typeof slots]>;

async function openStore(cipher?: DocCipher): Promise<SlotStore> {
  const store = await Store.create({
    adapter: new InMemoryAdapter(),
    collections: [slots] as const,
    encryption: cipher ? { cipher } : undefined,
  });
  stores.push(store);
  return store;
}

async function signIn(store: SlotStore, deviceName: string): Promise<void> {
  const begun = await store.sync.beginSignIn({
    url: server.origin,
    appId: 'app',
    deviceName,
    redirectUri: 'https://app.test/callback',
  });
  const redirect = server.authorize(begun.authorizeUrl, { username: 'alice', password: 'pw' });
  if ('error' in redirect) throw new Error(redirect.error);
  expect(await store.sync.completeSignIn(redirect)).toEqual({ ok: true });
}

async function signedInStore(deviceName: string, cipher?: DocCipher): Promise<SlotStore> {
  const store = await openStore(cipher);
  await signIn(store, deviceName);
  return store;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A parse task whose runs finish only when the test says so.
function controlledParse(store: SlotStore, overrides: { maxAttempts?: number } = {}) {
  const calls: Array<{
    note: string;
    signal: AbortSignal;
    finish: ReturnType<typeof deferred<string>>;
  }> = [];
  const task = defineTask({
    name: 'parse',
    input: z.object({ slotId: z.string(), note: z.string() }),
    run: (input, { signal }) => {
      const finish = deferred<string>();
      calls.push({ note: input.note, signal, finish });
      return finish.promise;
    },
    apply: async (input, result) => {
      if (!(await store.collection('slots').get(input.slotId))) return;
      await store.collection('slots').update(input.slotId, { parsed: result });
    },
    retryDelaysMs: [10],
    ...overrides,
  });
  return { task, calls };
}

async function lensCipher(): Promise<DocCipher> {
  return createWebCryptoCipher(await deriveEncryptionKey('lens', 'app', 1_000));
}

async function watchStates(store: SlotStore, key: string): Promise<Array<TaskState | null>> {
  const states: Array<TaskState | null> = [];
  store.tasks.watch(key, (state) => states.push(state));
  await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
  return states;
}

describe('tasks', () => {
  it('runs a task, applies the result and deletes the task', async () => {
    const store = await signedInStore('Phone');
    const { task, calls } = controlledParse(store);
    store.tasks.register(task);
    await store.collection('slots').create({ id: 'sl-1', note: 'eggs', parsed: null });
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    const states = await watchStates(store, 'parse:sl-1');

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('running'));
    expect(states.at(-1)?.attempts).toBe(1);
    calls[0]!.finish.resolve('2 eggs');

    await vi.waitFor(() => expect(states.at(-1)).toBeNull());
    expect((await store.collection('slots').get('sl-1'))?.parsed).toBe('2 eggs');
    expect(await store.tasks.get('parse:sl-1')).toBeNull();
    expect(server.claimOf('app', 'parse:sl-1')).toBeUndefined();
  });

  it('waits until signed in, so a task enqueued offline runs later', async () => {
    const store = await openStore();
    const { task, calls } = controlledParse(store);
    store.tasks.register(task);
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    expect((await store.tasks.get('parse:sl-1'))?.status).toBe('pending');
    expect(calls).toHaveLength(0);

    await signIn(store, 'Phone');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it('runs on one device only while the claim is held', async () => {
    const phone = await signedInStore('Phone');
    const laptop = await signedInStore('Laptop');
    const onPhone = controlledParse(phone);
    const onLaptop = controlledParse(laptop);
    phone.tasks.register(onPhone.task);
    await phone.tasks.enqueue(onPhone.task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    await vi.waitFor(() => expect(onPhone.calls).toHaveLength(1));

    laptop.tasks.register(onLaptop.task);
    await vi.waitFor(async () => expect((await laptop.tasks.get('parse:sl-1'))?.attempts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onLaptop.calls).toHaveLength(0);
  });

  it('lets another device take over once the claim expires', async () => {
    const phone = await signedInStore('Phone');
    const laptop = await signedInStore('Laptop');
    const onPhone = controlledParse(phone);
    const onLaptop = controlledParse(laptop);
    phone.tasks.register(onPhone.task);
    await phone.tasks.enqueue(onPhone.task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    await vi.waitFor(() => expect(onPhone.calls).toHaveLength(1));
    // The phone vanishes mid-run: it stops renewing and never releases.
    phone.dispose();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    laptop.tasks.register(onLaptop.task);
    await vi.waitFor(async () => expect((await laptop.tasks.get('parse:sl-1'))?.attempts).toBe(1));
    server.expireClaims('app');
    await vi.advanceTimersByTimeAsync(91_000);
    await vi.waitFor(() => expect(onLaptop.calls).toHaveLength(1));
    expect((await laptop.tasks.get('parse:sl-1'))?.attempts).toBe(2);
  });

  it('never applies a run whose input was replaced', async () => {
    const store = await signedInStore('Phone');
    const { task, calls } = controlledParse(store);
    store.tasks.register(task);
    await store.collection('slots').create({ id: 'sl-1', note: 'eggs', parsed: null });
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'milk' });
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.finish.resolve('2 eggs');

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.note).toBe('milk');
    expect((await store.tasks.get('parse:sl-1'))?.attempts).toBe(1);
    calls[1]!.finish.resolve('1 milk');
    await vi.waitFor(async () => expect(await store.tasks.get('parse:sl-1')).toBeNull());
    expect((await store.collection('slots').get('sl-1'))?.parsed).toBe('1 milk');
  });

  it('retries with backoff, then fails until retried', async () => {
    const store = await signedInStore('Phone');
    const { task, calls } = controlledParse(store, { maxAttempts: 2 });
    store.tasks.register(task);
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.finish.reject(new Error('model overloaded'));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.finish.reject(new Error('still overloaded'));

    await vi.waitFor(async () =>
      expect(await store.tasks.get('parse:sl-1')).toMatchObject({
        status: 'failed',
        attempts: 2,
        error: 'still overloaded',
        retryAt: null,
      })
    );
    expect(server.claimOf('app', 'parse:sl-1')).toBeUndefined();

    await store.tasks.retry('parse:sl-1');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect((await store.tasks.get('parse:sl-1'))?.attempts).toBe(1);
  });

  it('leaves tasks it cannot handle untouched', async () => {
    const store = await signedInStore('Phone');
    const { task: parse, calls } = controlledParse(store);
    const stricter: TaskDefinition<any, any> = {
      ...parse,
      input: z.object({ slotId: z.string(), note: z.string(), locale: z.string() }),
    };
    store.tasks.register(stricter);
    await store.tasks.enqueue(parse, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    const other = defineTask({
      name: 'score',
      input: z.object({}),
      run: async () => 0,
      apply: async () => {},
    });
    await store.tasks.enqueue(other, 'score:1', {});

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    expect((await store.tasks.get('parse:sl-1'))?.attempts).toBe(0);
    expect((await store.tasks.get('score:1'))?.attempts).toBe(0);
    expect(server.claimOf('app', 'parse:sl-1')).toBeUndefined();
  });

  it('aborts and drops a cancelled task', async () => {
    const store = await signedInStore('Phone');
    const { task, calls } = controlledParse(store);
    store.tasks.register(task);
    await store.collection('slots').create({ id: 'sl-1', note: 'eggs', parsed: null });
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await store.tasks.cancel('parse:sl-1');
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.finish.resolve('2 eggs');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.tasks.get('parse:sl-1')).toBeNull();
    expect((await store.collection('slots').get('sl-1'))?.parsed).toBeNull();
  });

  it('rejects input that fails the schema', async () => {
    const store = await openStore();
    const { task } = controlledParse(store);
    await expect(store.tasks.enqueue(task, 'parse:sl-1', { slotId: 1 } as never)).rejects.toThrow();
    expect(await store.tasks.get('parse:sl-1')).toBeNull();
  });

  it('finishes applying in its own lens before a switch', async () => {
    const store = await signedInStore('Phone');
    const applying = deferred<void>();
    const started = deferred<void>();
    const task = defineTask({
      name: 'parse',
      input: z.object({ slotId: z.string() }),
      run: async () => 'done',
      apply: async (input, result: string) => {
        started.resolve();
        await applying.promise;
        await store.collection('slots').update(input.slotId, { parsed: result });
      },
      retryDelaysMs: [10],
    });
    store.tasks.register(task);
    await store.collection('slots').create({ id: 'sl-1', note: 'eggs', parsed: null });
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1' });
    await started.promise;
    const switched = store.encryption.setKey(await lensCipher());
    await new Promise((resolve) => setTimeout(resolve, 20));
    applying.resolve();
    await switched;
    expect(await store.collection('slots').get('sl-1')).toBeNull();
    await store.encryption.setKey(null);
    expect((await store.collection('slots').get('sl-1'))?.parsed).toBe('done');
  });

  it('drops the result of a run a switch aborted, and claims per lens', async () => {
    const store = await signedInStore('Phone');
    const { task, calls } = controlledParse(store);
    store.tasks.register(task);
    const cipher = await lensCipher();
    await store.encryption.setKey(cipher);
    await store.collection('slots').create({ id: 'sl-1', note: 'eggs', parsed: null });
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(server.claimOf('app', `parse:sl-1@${await cipher.keyId()}`)).toBeDefined();
    await store.encryption.setKey(null);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.finish.resolve('late');
    await store.encryption.setKey(cipher);
    expect((await store.collection('slots').get('sl-1'))?.parsed).toBeNull();
  });

  it('keeps tasks stopped after dispose, even across a switch', async () => {
    const store = await signedInStore('Phone');
    const { task, calls } = controlledParse(store);
    store.tasks.register(task);
    store.dispose();
    await store.encryption.setKey(await lensCipher());
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'eggs' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
  });

  it('rejects task keys containing "@"', async () => {
    const store = await openStore();
    const { task } = controlledParse(store);
    await expect(
      store.tasks.enqueue(task, 'parse@sl-1', { slotId: 'sl-1', note: 'eggs' })
    ).rejects.toThrow(/must not contain "@"/);
  });

  it('encrypts tasks on the wire', async () => {
    const cipher = createWebCryptoCipher(
      await deriveEncryptionKey('passphrase', new TextEncoder().encode('salt-salt-salt-1'))
    );
    const store = await signedInStore('Phone', cipher);
    const { task } = controlledParse(store);
    await store.tasks.enqueue(task, 'parse:sl-1', { slotId: 'sl-1', note: 'secret eggs' });
    await store.sync.drain();
    const [version] = server.versionsOf('app', `_tasks@${await cipher.keyId()}`, 'parse:sl-1');
    expect(version).toBeDefined();
    expect(version!.data).not.toContain('secret eggs');
  });
});
