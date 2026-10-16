export type Migration<Out = unknown> = {
  from: number;
  to: number;
  // `any` on purpose: the runtime schema only describes the current shape, so
  // each migrator declares the older shape it accepts in its own signature.
  // Migrators must be pure: no IO and no reads from other collections.
  up: (doc: any) => Out;
  /**
   * Sample inputs at version `from`. Never read at runtime; domains can require
   * them in tests so every migration ships with a case run through `migrate`.
   */
  examples?: unknown[];
};

/**
 * `current` is stamped on new writes. `migrations` must form an unbroken chain
 * from version 1 to `current`; the runner walks it in order.
 */
export type CollectionMigrations = {
  current: number;
  migrations: Migration[];
};

/**
 * Pass the Zod-inferred document type as `Current` and the last migration's
 * `up` must return it, so adding a required field to the schema fails to
 * compile until the migration produces it. The check only bites when that
 * `up` has a typed return, which in practice means typing its input as a
 * frozen snapshot of the previous shape so spread fields keep real types.
 * Intermediate migrations stay loosely typed. The `current` number itself is
 * only verified at runtime.
 */
export function defineCollectionMigrations<Current = unknown>(def: {
  current: number;
  migrations: [] | [...Migration[], Migration<Current>];
}): CollectionMigrations {
  return def as CollectionMigrations;
}

export type MigrationRegistry = Record<string, CollectionMigrations>;

export class Migrator {
  private readonly registry: MigrationRegistry;

  constructor(registry: MigrationRegistry) {
    this.registry = registry;
  }

  /** Collections without a registry entry (the internal `_*` ones) are always at version 1. */
  currentVersion(collection: string): number {
    return this.registry[collection]?.current ?? 1;
  }

  migrate<T = unknown>(collection: string, doc: any): T {
    const reg = this.registry[collection];
    if (!reg) return doc as T;
    let v: number = typeof doc?.schemaVersion === 'number' ? doc.schemaVersion : 1;
    if (v > reg.current) {
      throw new Error(
        `Document ${collection}/${doc?.id} is at schemaVersion ${v} but this build only knows up to ${reg.current}. Upgrade the app.`
      );
    }
    let out = doc;
    while (v < reg.current) {
      const step = reg.migrations.find((m) => m.from === v);
      if (!step) {
        throw new Error(
          `No migrator for ${collection} schemaVersion ${v} -> ${v + 1}. Chain is incomplete.`
        );
      }
      out = step.up(out);
      v = step.to;
    }
    return { ...out, schemaVersion: reg.current } as T;
  }

  needsMigration(collection: string, doc: any): boolean {
    const reg = this.registry[collection];
    if (!reg) return false;
    const v: number = typeof doc?.schemaVersion === 'number' ? doc.schemaVersion : 1;
    return v < reg.current;
  }
}

export const noopMigrator = new Migrator({});
