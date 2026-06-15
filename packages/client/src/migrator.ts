/**
 * One step in a collection's migration chain. `up` takes a doc at version
 * `from` and returns a doc at version `to`. Migrators are pure functions —
 * they don't read from other collections or hit IO.
 *
 * `from` is typed `any` on purpose: each migrator describes the shape it
 * accepts in its own implementation; the runtime schema only covers the
 * *current* shape.
 */

export type Migration<Out = unknown> = {
  from: number;
  to: number;
  up: (doc: any) => Out;
  /**
   * Sample input docs at version `from`. Optional metadata the framework never
   * reads at runtime — domains can require these in tests so every migration
   * ships with at least one case that's run through `migrate` and validated.
   */
  examples?: unknown[];
};

/**
 * Per-collection migration registry. `current` is the latest schemaVersion
 * for this collection — new writes are stamped with it. `migrations` is the
 * chain from version 1..current; the runner walks it in order.
 */
export type CollectionMigrations = {
  current: number;
  migrations: Migration[];
};

/**
 * Builds a collection's migration set while type-checking that the LAST
 * migration's `up` returns the collection's current document shape `Current`
 * (pass the Zod-inferred doc type). Intermediate migrations stay loosely typed
 * since they produce interim shapes that no longer match any live schema.
 *
 * The check only bites if that last `up` has a typed return — in practice you
 * type its *input* as a frozen snapshot of the previous shape, so the spread of
 * unchanged fields carries real types through and TS can confirm the result is
 * a valid `Current`. Add a required field to the schema and the build breaks
 * until the migration produces it. The `current` *number* is verified at
 * runtime (see the migration registry test), not here.
 */
export function defineCollectionMigrations<Current = unknown>(def: {
  current: number;
  migrations: [] | [...Migration[], Migration<Current>];
}): CollectionMigrations {
  return def as CollectionMigrations;
}

export type MigrationRegistry = Record<string, CollectionMigrations>;

/**
 * Walks docs forward through their collection's migration chain. The
 * registry is fixed at construction so callers can pre-bind a domain
 * registry and pass the resulting instance to `Store`.
 */
export class Migrator {
  private readonly registry: MigrationRegistry;

  constructor(registry: MigrationRegistry) {
    this.registry = registry;
  }

  /**
   * Current schemaVersion for a collection, or 1 for unknown collections
   * (e.g. internal `_config`, `_sync_meta`, which aren't migrated).
   */
  currentVersion(collection: string): number {
    return this.registry[collection]?.current ?? 1;
  }

  /**
   * Walks a doc forward to the current version. Returns the input unchanged
   * if the collection has no registry entry, or if the doc is already at
   * current. Throws if the chain is missing a step (e.g. doc at v2 but no
   * `from: 2` migrator) or if the doc is newer than we know how to handle
   * (forward-incompat — likely an outdated build).
   */

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

  /**
   * True if the doc is behind the current version and would change under
   * `migrate`. Used by callers that want to know whether to write the
   * upgraded form back.
   */

  needsMigration(collection: string, doc: any): boolean {
    const reg = this.registry[collection];
    if (!reg) return false;
    const v: number = typeof doc?.schemaVersion === 'number' ? doc.schemaVersion : 1;
    return v < reg.current;
  }
}

/**
 * No-op migrator used as the default when a Store has no domain registry.
 * `migrate` returns docs unchanged; `currentVersion` is always 1.
 */
export const noopMigrator = new Migrator({});
