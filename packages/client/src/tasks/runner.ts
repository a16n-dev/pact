import type { TaskClaim } from '../sync/http';
import type { StoreTasks, TaskState } from '../store/namespaces';
import { MAX_KEY_LENGTH, assertKeyLength } from '../collection';
import { LENS_SUFFIX_LENGTH } from '../store/lens';
import { currentProgress, type TaskDefinition, type TaskDocument, type TaskProgress } from './task';
import type { Storable } from '../types';

// Well inside the server's 90 s claim, so one slow or dropped renewal never
// lets another device take over a run that is still going.
const RENEW_INTERVAL_MS = 30_000;
const OFFLINE_RETRY_MS = 30_000;
const MAX_CONCURRENT_RUNS = 3;

type TaskFields = Pick<TaskDocument, 'name' | 'input' | 'rev' | 'progress'>;

export type TaskWrite =
  | { kind: 'replace'; fields: TaskFields }
  | { kind: 'update'; fields: Partial<TaskFields> }
  | { kind: 'delete' };

export type TaskStoreAccess = {
  list(): Promise<TaskDocument[]>;
  get(key: string): Promise<TaskDocument | null>;
  /**
   * Under the task's document lock: `decide` sees the live task (null when
   * missing or deleted) and returns the write to make, or null for none.
   */
  mutate(key: string, decide: (task: TaskDocument | null) => TaskWrite | null): Promise<void>;
  newRev(): string;
  signedIn(): Promise<boolean>;
  // The server-side claim id for a task key in the active lens.
  claimId(key: string): string;
  claim(claimId: string, rev: string): Promise<TaskClaim>;
  release(claimId: string, rev: string): Promise<void>;
  onTasksChanged(listener: () => void): () => void;
};

// `finishing` is set once the handler returns and covers every write the
// run makes after it, so stopping can wait for those without waiting on a
// handler that ignores its signal.
type Run = {
  rev: string;
  claimId: string;
  controller: AbortController;
  finishing: Promise<void> | null;
};

type ListWatcher = { name: string | null; listener: (states: TaskState[]) => void };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TaskRunner {
  private readonly access: TaskStoreAccess;
  private readonly handlers = new Map<string, TaskDefinition<any, any>>();
  private readonly runs = new Map<string, Run>();
  private readonly watchers = new Map<string, Set<(state: TaskState | null) => void>>();
  private readonly listWatchers = new Set<ListWatcher>();
  private scanTask: Promise<void> | null = null;
  private scanPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAtMs = Infinity;
  private stopped = false;
  readonly api: StoreTasks;

  constructor(access: TaskStoreAccess, tasks: readonly TaskDefinition<any, any>[]) {
    this.access = access;
    for (const task of tasks) {
      if (this.handlers.has(task.name)) {
        throw new Error(`Duplicate task name "${task.name}" in StoreOptions.tasks`);
      }
      this.handlers.set(task.name, task);
    }
    access.onTasksChanged(() => {
      this.notifyWatchers();
      this.wake();
    });
    this.api = {
      enqueue: (task, key, input) => this.enqueue(task, key, input),
      cancel: (key) => this.cancel(key),
      retry: (key) => this.retry(key),
      get: (key) => this.state(key),
      watch: (key, listener) => this.watch(key, listener),
      list: (task) => this.states(task?.name ?? null),
      watchAll: (listener, task) => this.watchAll(task?.name ?? null, listener),
    };
  }

  // Resolves once no run can write any more.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.all(Array.from(this.runs.values(), (run) => run.finishing));
  }

  resume(): void {
    this.stopped = false;
    this.wake();
  }

  /** Looks for claimable tasks soon; calls while a scan runs coalesce into one more. */
  wake(): void {
    if (this.stopped || this.handlers.size === 0) return;
    this.scanPending = true;
    if (!this.scanTask) this.scanTask = this.runScans();
  }

  private async enqueue(task: TaskDefinition, key: string, input: unknown): Promise<void> {
    assertKeyLength('Task key', key, MAX_KEY_LENGTH - LENS_SUFFIX_LENGTH);
    if (key.includes('@')) throw new Error(`Task key "${key}" must not contain "@"`);
    if (this.handlers.get(task.name) !== task) {
      throw new Error(`Task "${task.name}" is not in StoreOptions.tasks`);
    }
    task.input.parse(input);
    // Stored as JSON, so a schema that outputs dates still re-parses on the running device.
    const stored = JSON.parse(JSON.stringify(input)) as TaskDocument['input'];
    const rev = this.access.newRev();
    await this.access.mutate(key, () => ({
      kind: 'replace',
      fields: { name: task.name, input: stored, rev, progress: null },
    }));
    this.abortStale(key, rev);
  }

  private async cancel(key: string): Promise<void> {
    await this.access.mutate(key, (task) => (task ? { kind: 'delete' } : null));
    this.runs.get(key)?.controller.abort();
  }

  private async retry(key: string): Promise<void> {
    await this.access.mutate(key, (task) =>
      task ? { kind: 'update', fields: { progress: null } } : null
    );
  }

  private abortStale(key: string, rev: string): void {
    const run = this.runs.get(key);
    if (run && run.rev !== rev) run.controller.abort();
  }

  private async state(key: string): Promise<TaskState | null> {
    const task = await this.access.get(key);
    return task ? this.toState(task) : null;
  }

  private async states(name: string | null): Promise<TaskState[]> {
    const tasks = await this.access.list();
    return tasks
      .filter((task) => name === null || task.name === name)
      .map((task) => this.toState(task))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private toState(task: TaskDocument): TaskState {
    const progress = currentProgress(task);
    const running = this.runs.get(task.id)?.rev === task.rev;
    return {
      key: task.id,
      name: task.name,
      status: progress?.failed ? 'failed' : running ? 'running' : 'pending',
      attempts: progress?.attempts ?? 0,
      error: progress?.error ?? null,
      retryAt: progress?.retryAtMs != null ? new Date(progress.retryAtMs) : null,
    };
  }

  private watch(key: string, listener: (state: TaskState | null) => void): () => void {
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(listener);
    void this.state(key).then((state) => {
      if (set.has(listener)) listener(state);
    });
    return () => {
      set.delete(listener);
      if (set.size === 0) this.watchers.delete(key);
    };
  }

  private watchAll(name: string | null, listener: (states: TaskState[]) => void): () => void {
    const watcher: ListWatcher = { name, listener };
    this.listWatchers.add(watcher);
    void this.states(name).then((states) => {
      if (this.listWatchers.has(watcher)) listener(states);
    });
    return () => this.listWatchers.delete(watcher);
  }

  private notifyWatchers(): void {
    for (const watcher of this.listWatchers) {
      void this.states(watcher.name).then((states) => {
        if (this.listWatchers.has(watcher)) watcher.listener(states);
      });
    }
    for (const [key, listeners] of this.watchers) {
      void this.state(key).then((state) => {
        for (const listener of listeners) listener(state);
      });
    }
  }

  private async runScans(): Promise<void> {
    try {
      while (this.scanPending && !this.stopped) {
        this.scanPending = false;
        await this.scan().catch(() => this.schedule(Date.now() + OFFLINE_RETRY_MS));
      }
    } finally {
      this.scanTask = null;
    }
  }

  private async scan(): Promise<void> {
    // Sign-in wakes the runner, so nothing needs scheduling while signed out.
    if (!(await this.access.signedIn())) return;
    const nowMs = Date.now();
    for (const task of await this.access.list()) {
      if (this.stopped || this.runs.size >= MAX_CONCURRENT_RUNS) return;
      if (this.runs.has(task.id)) continue;
      const handler = this.handlers.get(task.name);
      if (!handler || !handler.input.safeParse(task.input).success) continue;
      const progress = currentProgress(task);
      if (progress?.failed) continue;
      if (progress?.retryAtMs != null && progress.retryAtMs > nowMs) {
        this.schedule(progress.retryAtMs);
        continue;
      }
      await this.start(task, handler, progress);
    }
  }

  private schedule(atMs: number): void {
    if (this.stopped || atMs >= this.timerAtMs) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAtMs = atMs;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAtMs = Infinity;
        this.wake();
      },
      Math.max(0, atMs - Date.now())
    );
  }

  private async start(
    task: TaskDocument,
    handler: TaskDefinition,
    progress: TaskProgress | null
  ): Promise<void> {
    const { id: key, rev } = task;
    const claimId = this.access.claimId(key);
    const claim = await this.access.claim(claimId, rev);
    if (!claim.claimed) {
      this.schedule(claim.expiresAt);
      return;
    }
    let counted = false;
    const attempts = (progress?.attempts ?? 0) + 1;
    await this.access.mutate(key, (current) => {
      if (current?.rev !== rev) return null;
      counted = true;
      const next: TaskProgress = { rev, attempts, retryAtMs: null, error: null, failed: false };
      return { kind: 'update', fields: { progress: next } };
    });
    if (!counted) {
      await this.access.release(claimId, rev).catch(() => {});
      return;
    }
    const run: Run = { rev, claimId, controller: new AbortController(), finishing: null };
    this.runs.set(key, run);
    this.notifyWatchers();
    void this.execute(key, rev, task.input, handler, attempts, run).finally(() => {
      if (this.runs.get(key) === run) this.runs.delete(key);
      this.notifyWatchers();
      this.wake();
    });
  }

  private async execute(
    key: string,
    rev: string,
    stored: unknown,
    handler: TaskDefinition,
    attempts: number,
    run: Run
  ): Promise<void> {
    const { signal } = run.controller;
    const renew = setInterval(() => {
      void this.access.claim(run.claimId, rev).then(
        (claim) => {
          if (!claim.claimed) run.controller.abort();
        },
        () => {}
      );
    }, RENEW_INTERVAL_MS);
    const input = handler.input.parse(stored);
    let outcome: { result: unknown } | { error: unknown };
    try {
      outcome = { result: await handler.run(input, { signal }) };
    } catch (error) {
      outcome = { error };
    }
    clearInterval(renew);
    if (signal.aborted) return;
    run.finishing = this.finish(key, rev, input, handler, attempts, run, outcome);
    await run.finishing;
  }

  private async finish(
    key: string,
    rev: string,
    input: Storable,
    handler: TaskDefinition,
    attempts: number,
    run: Run,
    outcome: { result: unknown } | { error: unknown }
  ): Promise<void> {
    try {
      if ('error' in outcome) throw outcome.error;
      if (!(await this.stillHeld(run.claimId, rev))) return;
      let current = false;
      await this.access.mutate(key, (task) => {
        current = task?.rev === rev;
        return null;
      });
      if (!current || run.controller.signal.aborted) return;
      await handler.apply(input, outcome.result);
      await this.access.mutate(key, (task) => (task?.rev === rev ? { kind: 'delete' } : null));
    } catch (err) {
      if (run.controller.signal.aborted) return;
      await this.recordFailure(key, rev, handler, attempts, messageOf(err));
    }
    await this.access.release(run.claimId, rev).catch(() => {});
  }

  // The last renewal before applying. Only the server refusing stops the
  // apply: when the check itself fails the result is applied anyway, since
  // applying twice is harmless and dropping a finished result wastes the run.
  private async stillHeld(claimId: string, rev: string): Promise<boolean> {
    try {
      return (await this.access.claim(claimId, rev)).claimed;
    } catch {
      return true;
    }
  }

  private async recordFailure(
    key: string,
    rev: string,
    handler: TaskDefinition,
    attempts: number,
    error: string
  ): Promise<void> {
    const failed = attempts >= handler.maxAttempts;
    const delays = handler.retryDelaysMs;
    const delayMs = delays[Math.min(attempts, delays.length) - 1]!;
    const retryAtMs = failed ? null : Date.now() + delayMs;
    await this.access.mutate(key, (task) =>
      task?.rev === rev
        ? { kind: 'update', fields: { progress: { rev, attempts, retryAtMs, error, failed } } }
        : null
    );
    if (retryAtMs !== null) this.schedule(retryAtMs);
  }
}
