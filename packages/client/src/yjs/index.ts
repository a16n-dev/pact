import * as Y from 'yjs';
import { z } from 'zod';
import { registerTextField, type TextDocument, type TextEngine } from '../text/engine';
import { fromBase64, toBase64 } from '../crypto/base64';

/** Origin tag for transactions the store applies itself (remote merges, replace-all writes). */
const STORE_ORIGIN = Symbol('pact');

class YjsTextDocument implements TextDocument<Y.Text> {
  readonly doc = new Y.Doc();
  private readonly fields: readonly string[];

  constructor(fields: readonly string[], state?: string) {
    this.fields = fields;
    if (state) Y.applyUpdate(this.doc, fromBase64(state), STORE_ORIGIN);
  }

  handle(field: string): Y.Text {
    this.assertField(field);
    return this.doc.getText(field);
  }

  toString(field: string): string {
    return this.handle(field).toString();
  }

  replace(field: string, value: string): void {
    const text = this.handle(field);
    if (text.toString() === value) return;
    this.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, value);
    }, STORE_ORIGIN);
  }

  encode(): string {
    return toBase64(Y.encodeStateAsUpdate(this.doc));
  }

  merge(state: string): boolean {
    const before = Y.encodeStateAsUpdate(this.doc);
    Y.applyUpdate(this.doc, fromBase64(state), STORE_ORIGIN);
    return !bytesEqual(before, Y.encodeStateAsUpdate(this.doc));
  }

  onLocalChange(handler: (fields: readonly string[]) => void): () => void {
    const listener = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, tx: Y.Transaction) => {
      if (origin === STORE_ORIGIN) return;
      const touched = this.fields.filter((field) =>
        tx.changed.has(this.doc.getText(field) as unknown as Y.AbstractType<Y.YEvent<any>>)
      );
      if (touched.length > 0) handler(touched);
    };
    this.doc.on('update', listener);
    return () => this.doc.off('update', listener);
  }

  destroy(): void {
    this.doc.destroy();
  }

  private assertField(field: string): void {
    if (!this.fields.includes(field)) throw new Error(`"${field}" is not a text field`);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export const yjsTextEngine: TextEngine<Y.Text> = {
  open(fields, state) {
    return new YjsTextDocument(fields, state);
  },
};

/**
 * A collaborative text field. Reads project it to a `string`; edits go
 * through the `Y.Text` from `collection.text(id, field)`. Writes may pass a
 * `string`, which lands as a replace-all edit.
 */
export function yText(): z.ZodString {
  const schema = z.string();
  registerTextField(schema, yjsTextEngine);
  return schema;
}
