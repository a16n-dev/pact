import { z } from 'zod';
import type { CollectionDefinition } from '../collection';
import { BaseDocumentSchema, type Storable } from '../types';

export type TaskContext = {
  /** Aborted when this device loses the claim or the task is replaced, cancelled or disposed. */
  signal: AbortSignal;
};

export type TaskDefinition<
  Schema extends z.ZodType<Storable> = z.ZodType<Storable>,
  Result = unknown,
> = {
  name: string;
  input: Schema;
  run(input: z.output<Schema>, ctx: TaskContext): Promise<Result>;
  apply(input: z.output<Schema>, result: Result): Promise<void>;
  maxAttempts: number;
  retryDelaysMs: readonly number[];
};

export type TaskConfig<Schema extends z.ZodType<Storable>, Result> = {
  /** Stored on every task, so renaming orphans tasks still queued under the old name. */
  name: string;
  /**
   * Validated on enqueue and again before a device runs the task. A device
   * whose schema rejects the stored input leaves the task for one that accepts it.
   */
  input: Schema;
  /** The slow work. Runs on whichever device claims the task, only while signed in. */
  run(input: z.output<Schema>, ctx: TaskContext): Promise<Result>;
  /**
   * Writes the result into app documents, on the device that ran the task,
   * only if the task's input has not been replaced since. May run more than
   * once for the same input, so it must set values rather than append, and
   * do nothing when the documents it targets are missing.
   */
  apply(input: z.output<Schema>, result: Result): Promise<void>;
  /** Defaults to 3. An attempt counts when the task is claimed, so a crash mid-run counts too. */
  maxAttempts?: number;
  /** Wait before each retry; the last entry repeats. Defaults to 30 s, then 2 min. */
  retryDelaysMs?: readonly number[];
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000];

export function defineTask<Schema extends z.ZodType<Storable>, Result>(
  config: TaskConfig<Schema, Result>
): TaskDefinition<Schema, Result> {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelaysMs = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Task "${config.name}" needs maxAttempts of at least 1`);
  }
  if (retryDelaysMs.length === 0) {
    throw new Error(`Task "${config.name}" needs at least one retry delay`);
  }
  return { ...config, maxAttempts, retryDelaysMs };
}

// One field rather than several so that a field-level merge can never pair
// an older run's attempt count with a newer `rev`: progress whose `rev` is
// not the task's belongs to replaced input and reads as no progress.
const ProgressSchema = z.object({
  rev: z.string(),
  attempts: z.number().int().nonnegative(),
  retryAtMs: z.number().nullable(),
  error: z.string().nullable(),
  failed: z.boolean(),
});

export type TaskProgress = z.infer<typeof ProgressSchema>;

const TaskDocumentSchema = BaseDocumentSchema.extend({
  name: z.string(),
  input: z.json(),
  rev: z.string(),
  progress: ProgressSchema.nullable(),
});

export type TaskDocument = z.infer<typeof TaskDocumentSchema>;

// Built by hand because `defineCollection` refuses the reserved `_` namespace.
// Synced and encrypted like an app collection; the id is the caller's task key.
export const TASKS: CollectionDefinition = {
  name: '_tasks',
  key: '_tasks',
  idPrefix: '',
  synced: true,
  merge: 'field',
  ids: 'slug',
  schema: TaskDocumentSchema,
  textFields: [],
  textEngine: null,
  generateId: () => {
    throw new Error('Tasks are keyed by the caller');
  },
  indexes: {},
};

export function currentProgress(task: TaskDocument): TaskProgress | null {
  return task.progress?.rev === task.rev ? task.progress : null;
}
