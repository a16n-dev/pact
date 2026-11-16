import { createWebCryptoCipher, deriveEncryptionKey } from '@a16n/pact-client';
import { act, screen, waitFor } from '@testing-library/react';
import { Component, type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCache } from '../src/liveCache';
import { createStore, renderWithPact, sleep, useLiveQuery } from './harness';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function slowQuery(key: string, delayMs: number, reads: Record<string, number>) {
  return {
    key: [key],
    collections: ['notes' as const],
    read: async () => {
      reads[key] = (reads[key] ?? 0) + 1;
      await sleep(delayMs);
      return key;
    },
  };
}

class Resettable extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <button onClick={() => this.setState({ error: null })}>
        retry {this.state.error.message}
      </button>
    ) : (
      <Suspense fallback={<p>loading</p>}>{this.props.children}</Suspense>
    );
  }
}

// Outside act, React schedules and retries suspended renders as it would in an app.
describe('suspended renders outside act', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  afterEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('commits a component whose two reads each take over a second', async () => {
    const store = await createStore();
    const reads: Record<string, number> = {};
    function Both() {
      const a = useLiveQuery(slowQuery('first', 1_100, reads));
      const b = useLiveQuery(slowQuery('second', 1_100, reads));
      return (
        <p>
          both {a} {b}
        </p>
      );
    }
    renderWithPact(<Both />, { open: async () => store });
    await waitFor(() => expect(screen.getByText('both first second')).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(reads).toEqual({ first: 1, second: 1 });
  }, 10_000);

  it('commits siblings in one boundary whose reads take over a second', async () => {
    const store = await createStore();
    const reads: Record<string, number> = {};
    function Slow({ name, delayMs }: { name: string; delayMs: number }) {
      return <p>got {useLiveQuery(slowQuery(name, delayMs, reads))}</p>;
    }
    renderWithPact(
      <>
        <Slow name='quick' delayMs={1_200} />
        <Slow name='slow' delayMs={2_500} />
      </>,
      { open: async () => store }
    );
    await waitFor(() => expect(screen.getByText('got slow')).toBeTruthy(), { timeout: 6_000 });
    expect(screen.getByText('got quick')).toBeTruthy();
    expect(reads).toEqual({ quick: 1, slow: 1 });
  }, 10_000);
});

describe('failed reads', () => {
  it('reads again when an error boundary resets after a failed first read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await createStore();
    let failing = true;
    function Flaky() {
      const value = useLiveQuery({
        key: ['flaky'],
        collections: ['notes'],
        read: async () => {
          if (failing) throw new Error('down');
          return 'up';
        },
      });
      return <p>value {value}</p>;
    }
    renderWithPact(
      <Resettable>
        <Flaky />
      </Resettable>,
      { open: async () => store }
    );
    await screen.findByText('retry down');
    failing = false;
    await act(async () => screen.getByText('retry down').click());
    expect(await screen.findByText('value up')).toBeTruthy();
  });

  it('reads again when an error boundary resets after a failed re-read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await createStore();
    function Count() {
      const count = useLiveQuery({
        key: ['boom-count'],
        collections: ['notes'],
        read: async (s) => {
          const notes = await s.collection('notes').list();
          if (notes.some((note) => note.title === 'boom')) throw new Error('boom');
          return notes.length;
        },
      });
      return <p>count {count}</p>;
    }
    renderWithPact(
      <Resettable>
        <Count />
      </Resettable>,
      { open: async () => store }
    );
    await screen.findByText('count 0');
    const note = await store.collection('notes').create({ title: 'boom' });
    await screen.findByText('retry boom');
    await store.collection('notes').update(note.id, { title: 'fine' });
    await sleep(100);
    await act(async () => screen.getByText('retry boom').click());
    expect(await screen.findByText('count 1')).toBeTruthy();
  });
});

describe('lens switch', () => {
  it('never shows the old lens once the switch has finished', async () => {
    const store = await createStore();
    await store.collection('notes').create({ id: 'nt-1', title: 'plain' });
    let hold: Promise<void> | null = null;
    let switched = false;
    const shownAfterSwitch: string[] = [];
    function Titles() {
      const titles = useLiveQuery({
        key: ['titles'],
        collections: ['notes'],
        read: async (s) => {
          const listed = (await s.collection('notes').list()).map((note) => note.title);
          if (hold) await hold;
          return listed.join(',') || 'empty';
        },
      });
      if (switched) shownAfterSwitch.push(titles);
      return <p>titles {titles}</p>;
    }
    renderWithPact(<Titles />, { open: async () => store });
    await screen.findByText('titles plain');
    const held = deferred();
    hold = held.promise;
    await store.collection('notes').update('nt-1', { title: 'plain edited' });
    await sleep(80);
    const cipher = createWebCryptoCipher(await deriveEncryptionKey('pw', 'salt', 1_000));
    await store.encryption.setKey(cipher);
    switched = true;
    hold = null;
    held.resolve();
    expect(await screen.findByText('titles empty')).toBeTruthy();
    await sleep(100);
    expect(shownAfterSwitch.every((titles) => titles === 'empty')).toBe(true);
  });
});

describe('LiveCache', () => {
  it('brings back a dropped entry when something subscribes to it, reading once', async () => {
    const store = await createStore();
    const cache = new LiveCache(store);
    let reads = 0;
    const entry = cache.entry('k', ['notes'], async () => {
      reads += 1;
      return (await store.collection('notes').list()).length;
    });
    await entry.loaded;
    entry.subscribe(() => {})();
    await store.collection('notes').create({ title: 'a' });
    await sleep(1_100);
    expect(reads).toBe(1);

    const listener = vi.fn();
    entry.subscribe(listener);
    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(entry.getSnapshot()).toEqual({ status: 'ok', value: 1 });
    await sleep(100);
    expect(reads).toBe(2);

    await store.collection('notes').create({ title: 'b' });
    await waitFor(() => expect(entry.getSnapshot()).toEqual({ status: 'ok', value: 2 }));
    cache.dispose();
  });
});

describe('keys', () => {
  it('accepts only JSON primitives', () => {
    const check = () =>
      useLiveQuery({
        // @ts-expect-error a Set would serialise like an empty object and collide
        key: ['tagged', new Set(['a'])],
        collections: ['notes'],
        read: async () => 0,
      });
    expect(typeof check).toBe('function');
  });
});
