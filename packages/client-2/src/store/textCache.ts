import type { CollectionDefinition } from '../collection';
import type { TextDocument } from '../text/engine';

/**
 * Live text documents, one per loaded record with text fields. The cached
 * document is the source of truth for its fields while loaded: reads
 * project from it, merges apply into it, and `collection.text()` hands it out.
 */
export class TextCache {
  private readonly docs = new Map<string, TextDocument>();

  get(collection: string, id: string): TextDocument | undefined {
    return this.docs.get(`${collection}/${id}`);
  }

  open(def: CollectionDefinition, id: string, state: string | undefined): TextDocument {
    const key = `${def.name}/${id}`;
    const existing = this.docs.get(key);
    if (existing) return existing;
    const doc = def.textEngine!.open(def.textFields, state);
    this.docs.set(key, doc);
    return doc;
  }

  /** Reopens the document from stored state, as after a replace-mode restore. */
  drop(collection: string, id: string): void {
    const key = `${collection}/${id}`;
    this.docs.get(key)?.destroy();
    this.docs.delete(key);
  }

  clear(): void {
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
  }
}
