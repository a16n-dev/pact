import { act, screen, waitFor } from '@testing-library/react';
import { type ReactNode, Suspense, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createStore,
  renderWithPact,
  signedInStore,
  sleep,
  useCollection,
  useDocument,
  useLiveQuery,
  type TestStore,
} from './harness';

// Past the grace an entry gets after its last subscriber leaves.
const PAST_UNSUBSCRIBED_TTL_MS = 1_100;
// Past the cap on an entry no component ever subscribed to.
const PAST_NEVER_SUBSCRIBED_TTL_MS = 61_000;

function NoteTitles() {
  const notes = useCollection('notes');
  return <p>titles: {notes.map((note) => note.title).join(',')}</p>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// A note count whose reads are counted and can be held at the first await.
function countedRead() {
  const counter = {
    reads: 0,
    settled: 0,
    hold: null as Promise<void> | null,
    rendered: [] as number[],
  };
  const read = async (store: TestStore) => {
    counter.reads += 1;
    const notes = await store.collection('notes').list();
    if (counter.hold) await counter.hold;
    counter.settled += 1;
    return notes.length;
  };
  function NoteCount({ label = 'count' }: { label?: string }) {
    const count = useLiveQuery({ key: ['note-count'], collections: ['notes'], read });
    if (counter.rendered.at(-1) !== count) counter.rendered.push(count);
    return (
      <p>
        {label}: {count}
      </p>
    );
  }
  return { counter, NoteCount };
}

// Lets microtask-only work finish while timers are faked.
async function settle(done: () => boolean) {
  for (let i = 0; i < 10_000 && !done(); i++) await Promise.resolve();
  if (!done()) throw new Error('did not settle');
}

function Toggle({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown(!shown)}>{shown ? 'hide' : 'show'}</button>
      <Suspense fallback={<p>loading</p>}>{shown && children}</Suspense>
    </>
  );
}

describe('live reads', () => {
  it('suspends, then updates on a local write', async () => {
    const store = await createStore();
    renderWithPact(<NoteTitles />, { open: async () => store });
    expect(await screen.findByText('loading')).toBeTruthy();
    expect(await screen.findByText('titles:')).toBeTruthy();
    await store.collection('notes').create({ title: 'a' });
    expect(await screen.findByText('titles: a')).toBeTruthy();
  });

  it('updates on a pull', async () => {
    const store = await signedInStore('Laptop');
    store.dispose();
    const other = await signedInStore('Phone');
    renderWithPact(<NoteTitles />, { open: async () => store });
    await screen.findByText('titles:');
    await other.collection('notes').create({ title: 'remote' });
    await other.sync.drain();
    await store.sync.pull();
    expect(await screen.findByText('titles: remote')).toBeTruthy();
    other.dispose();
  });

  it('reads one document by id, following a change of id', async () => {
    const store = await createStore();
    await store.collection('notes').create({ id: 'nt-1', title: 'one' });
    await store.collection('notes').create({ id: 'nt-2', title: 'two' });
    let showId: (id: string) => void = () => {};
    function Note() {
      const [id, setId] = useState('nt-1');
      showId = setId;
      const note = useDocument('notes', id);
      return <p>note: {note?.title ?? 'none'}</p>;
    }
    renderWithPact(<Note />, { open: async () => store });
    expect(await screen.findByText('note: one')).toBeTruthy();
    await act(async () => showId('nt-2'));
    expect(await screen.findByText('note: two')).toBeTruthy();
    await act(async () => showId('nt-missing'));
    expect(await screen.findByText('note: none')).toBeTruthy();
    await store.collection('notes').create({ id: 'nt-missing', title: 'now here' });
    expect(await screen.findByText('note: now here')).toBeTruthy();
  });

  it('shares one read between components using the same key', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    renderWithPact(
      <>
        <NoteCount label='first' />
        <NoteCount label='second' />
      </>,
      { open: async () => store }
    );
    await screen.findByText('first: 0');
    expect(screen.getByText('second: 0')).toBeTruthy();
    expect(counter.reads).toBe(1);
    await store.collection('notes').create({ title: 'a' });
    await screen.findByText('first: 1');
    expect(screen.getByText('second: 1')).toBeTruthy();
    expect(counter.reads).toBe(2);
  });

  it('keeps the same result object between changes', async () => {
    const store = await createStore();
    await store.collection('notes').create({ title: 'a' });
    const seen: unknown[] = [];
    let rerender: (n: number) => void = () => {};
    function Notes() {
      const [n, setN] = useState(0);
      rerender = setN;
      const notes = useCollection('notes');
      seen.push(notes);
      return <p>render {n}</p>;
    }
    renderWithPact(<Notes />, { open: async () => store });
    await screen.findByText('render 0');
    act(() => rerender(1));
    await screen.findByText('render 1');
    expect(new Set(seen).size).toBe(1);
  });

  it('batches changes that arrive together into one read', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    renderWithPact(<NoteCount />, { open: async () => store });
    await screen.findByText('count: 0');
    await store.collection('notes').create({ title: 'a' });
    await store.collection('notes').create({ title: 'b' });
    await store.collection('notes').create({ title: 'c' });
    await screen.findByText('count: 3');
    await sleep(100);
    expect(counter.reads).toBe(2);
  });

  it('reads again after a read that a change arrived during, never landing stale', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    renderWithPact(<NoteCount />, { open: async () => store });
    await screen.findByText('count: 0');
    const hold = deferred();
    counter.hold = hold.promise;
    await store.collection('notes').create({ title: 'a' });
    await waitFor(() => expect(counter.reads).toBe(2));
    await store.collection('notes').create({ title: 'b' });
    await sleep(100);
    counter.hold = null;
    hold.resolve();
    expect(await screen.findByText('count: 2')).toBeTruthy();
    await sleep(100);
    expect(counter.reads).toBe(3);
    expect(counter.rendered).toEqual([0, 2]);
  });

  it('stops reading when nothing uses it', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    renderWithPact(
      <Toggle>
        <NoteCount />
      </Toggle>,
      { open: async () => store }
    );
    await screen.findByText('count: 0');
    await act(async () => screen.getByText('hide').click());
    await store.collection('notes').create({ title: 'a' });
    await sleep(100);
    expect(counter.reads).toBe(1);
  });

  it('keeps a first read until its suspended component mounts', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    const hold = deferred();
    counter.hold = hold.promise;
    renderWithPact(<NoteCount />, { open: async () => store });
    await waitFor(() => expect(counter.reads).toBe(1));
    await sleep(PAST_UNSUBSCRIBED_TTL_MS);
    counter.hold = null;
    hold.resolve();
    expect(await screen.findByText('count: 0')).toBeTruthy();
    expect(counter.reads).toBe(1);
  });

  it('drops a read a few moments after its last subscriber leaves', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    renderWithPact(
      <Toggle>
        <NoteCount />
      </Toggle>,
      { open: async () => store }
    );
    await screen.findByText('count: 0');
    await act(async () => screen.getByText('hide').click());
    await act(async () => screen.getByText('show').click());
    await screen.findByText('count: 0');
    expect(counter.reads).toBe(1);

    await act(async () => screen.getByText('hide').click());
    await sleep(PAST_UNSUBSCRIBED_TTL_MS);
    await act(async () => screen.getByText('show').click());
    await screen.findByText('count: 0');
    expect(counter.reads).toBe(2);
  });

  it('keeps a read whose component never mounted past the short grace', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    const hold = deferred();
    counter.hold = hold.promise;
    renderWithPact(
      <Toggle>
        <NoteCount />
      </Toggle>,
      { open: async () => store }
    );
    await waitFor(() => expect(counter.reads).toBe(1));
    await act(async () => screen.getByText('hide').click());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    counter.hold = null;
    hold.resolve();
    await settle(() => counter.settled === 1);
    vi.advanceTimersByTime(PAST_UNSUBSCRIBED_TTL_MS);
    vi.useRealTimers();
    await act(async () => screen.getByText('show').click());
    await screen.findByText('count: 0');
    expect(counter.reads).toBe(1);
  });

  it('drops a read whose component never mounted once the cap passes', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    const hold = deferred();
    counter.hold = hold.promise;
    renderWithPact(
      <Toggle>
        <NoteCount />
      </Toggle>,
      { open: async () => store }
    );
    await waitFor(() => expect(counter.reads).toBe(1));
    await act(async () => screen.getByText('hide').click());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    counter.hold = null;
    hold.resolve();
    await settle(() => counter.settled === 1);
    vi.advanceTimersByTime(PAST_NEVER_SUBSCRIBED_TTL_MS);
    vi.useRealTimers();
    await act(async () => screen.getByText('show').click());
    await screen.findByText('count: 0');
    expect(counter.reads).toBe(2);
  });

  it('throws a failed first read and a failed re-read to the error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await createStore();
    function Failing() {
      const titles = useLiveQuery({
        key: ['failing'],
        collections: ['notes'],
        read: async (s) => {
          const notes = await s.collection('notes').list();
          if (notes.some((note) => note.title === 'boom')) throw new Error('read failed');
          return notes.length;
        },
      });
      return <p>count: {titles}</p>;
    }
    renderWithPact(<Failing />, { open: async () => store });
    await screen.findByText('count: 0');
    await store.collection('notes').create({ title: 'boom' });
    expect(await screen.findByText('caught: read failed')).toBeTruthy();

    const failingFromStart = await createStore();
    await failingFromStart.collection('notes').create({ title: 'boom' });
    renderWithPact(<Failing />, { open: async () => failingFromStart });
    await waitFor(() => expect(screen.getAllByText('caught: read failed')).toHaveLength(2));
  });

  it('works under StrictMode', async () => {
    const store = await createStore();
    const { counter, NoteCount } = countedRead();
    renderWithPact(<NoteCount />, { open: async () => store, strict: true });
    await screen.findByText('count: 0');
    expect(counter.reads).toBe(1);
    await store.collection('notes').create({ title: 'a' });
    expect(await screen.findByText('count: 1')).toBeTruthy();
    expect(counter.reads).toBe(2);
  });
});
