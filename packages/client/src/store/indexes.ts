/** Always a string, so equality is a plain string match on any backend. */
export type IndexKey = string;

/**
 * Normalised to a string before storage and lookup (`Date` to ISO 8601,
 * everything else via `String`), so `listByIndex('priority', 2)` matches an
 * extractor that returned the number `2`.
 */
export type IndexKeyInput = string | number | boolean | bigint | Date;

/**
 * Returns one key, many keys (a multi-valued field like `tags`), or `[]` to
 * exclude the doc. Runs on the migrated, validated document.
 */
export type IndexExtractor<Doc> = (doc: Doc) => IndexKeyInput | readonly IndexKeyInput[];

export type IndexMap<Doc> = Record<string, IndexExtractor<Doc>>;

export function normalizeKey(value: IndexKeyInput): IndexKey {
  return value instanceof Date ? value.toISOString() : String(value);
}

type RuntimeIndex = {
  collection: string;
  name: string;
  extract: IndexExtractor<Record<string, unknown>>;
};

// Drops nullish entries (an absent optional field) and dedupes so a doc
// counts once per key.
function normalizeKeys(raw: IndexKeyInput | readonly IndexKeyInput[]): IndexKey[] {
  const values = Array.isArray(raw) ? raw : [raw as IndexKeyInput];
  const out: IndexKey[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if ((value as unknown) === null || (value as unknown) === undefined) continue;
    const s = normalizeKey(value);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// In-memory inverted index over decrypted, migrated docs: equality lookups
// only, nothing persisted, so it works unchanged under encryption. Derived
// state rebuilt on every `Store.create`, which is why there is no version
// field. `reverse` records the keys currently held for each doc so a write
// can compute removals without the document's previous state.
export class IndexManager {
  private readonly forward = new Map<string, Map<IndexKey, Set<string>>>();
  private readonly reverse = new Map<string, Map<string, readonly IndexKey[]>>();
  private readonly byCollection = new Map<string, RuntimeIndex[]>();

  constructor(collections: Iterable<{ name: string; indexes: IndexMap<never> }>) {
    for (const { name: collection, indexes } of collections) {
      for (const [name, extract] of Object.entries(indexes)) {
        const runtime: RuntimeIndex = {
          collection,
          name,
          extract: extract as IndexExtractor<Record<string, unknown>>,
        };
        const id = this.id(collection, name);
        this.forward.set(id, new Map());
        this.reverse.set(id, new Map());
        const list = this.byCollection.get(collection);
        if (list) list.push(runtime);
        else this.byCollection.set(collection, [runtime]);
      }
    }
  }

  get isEmpty(): boolean {
    return this.byCollection.size === 0;
  }

  hasIndexesFor(collection: string): boolean {
    return this.byCollection.has(collection);
  }

  has(collection: string, name: string): boolean {
    return this.forward.has(this.id(collection, name));
  }

  indexedCollections(): string[] {
    return Array.from(this.byCollection.keys());
  }

  // Indexes cover live docs only, mirroring `list()`, so a tombstone is removed.
  onPersist(collection: string, doc: { id: string; deletedAt: string | null }): void {
    const defs = this.byCollection.get(collection);
    if (!defs) return;
    const live = !doc.deletedAt;
    for (const def of defs) {
      const keys = live
        ? normalizeKeys(def.extract(doc as unknown as Record<string, unknown>))
        : [];
      this.reindex(this.id(collection, def.name), doc.id, keys);
    }
  }

  onRemove(collection: string, id: string): void {
    const defs = this.byCollection.get(collection);
    if (!defs) return;
    for (const def of defs) this.reindex(this.id(collection, def.name), id, []);
  }

  clear(): void {
    for (const map of this.forward.values()) map.clear();
    for (const map of this.reverse.values()) map.clear();
  }

  find(collection: string, name: string, key: IndexKey): string[] {
    const bucket = this.forward.get(this.id(collection, name))?.get(key);
    return bucket ? Array.from(bucket) : [];
  }

  keys(collection: string, name: string): IndexKey[] {
    return Array.from(this.forward.get(this.id(collection, name))?.keys() ?? []);
  }

  private id(collection: string, name: string): string {
    return `${collection} ${name}`;
  }

  // Emptied buckets are dropped so `keys()` stays exact.
  private reindex(id: string, docId: string, keys: readonly IndexKey[]): void {
    const forward = this.forward.get(id);
    const reverse = this.reverse.get(id);
    if (!forward || !reverse) return;
    const previous = reverse.get(docId);
    if (previous) {
      for (const key of previous) {
        const bucket = forward.get(key);
        if (!bucket) continue;
        bucket.delete(docId);
        if (bucket.size === 0) forward.delete(key);
      }
    }
    if (keys.length === 0) {
      reverse.delete(docId);
      return;
    }
    for (const key of keys) {
      let bucket = forward.get(key);
      if (!bucket) {
        bucket = new Set();
        forward.set(key, bucket);
      }
      bucket.add(docId);
    }
    reverse.set(docId, keys);
  }
}
