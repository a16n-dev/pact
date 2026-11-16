import type { z } from 'zod';
import type { TextSplice } from './diff';

/**
 * One live text document per stored record, holding one text type per text
 * field. Implemented by the `@a16n/pact-client/yjs` subpath; the core never
 * imports Yjs. `Handle` is the editable type handed to app code.
 */
export type TextDocument<Handle = unknown> = {
  handle(field: string): Handle;
  toString(field: string): string;
  /** Applies the splices in order as one transaction, which is how a string write to a text field lands. */
  splice(field: string, splices: readonly TextSplice[]): void;
  /** Base64 state for the stored record. */
  encode(): string;
  /** Merges another encoding of the same document; true when local state changed. */
  merge(state: string): boolean;
  /** Fires once per local transaction with the fields it touched; remote merges don't fire it. */
  onLocalChange(handler: (fields: readonly string[]) => void): () => void;
  destroy(): void;
};

export type TextEngine<Handle = unknown> = {
  open(fields: readonly string[], state?: string): TextDocument<Handle>;
  /**
   * Fresh state holding `values` (one per field) and no history. It must be
   * deterministic in its arguments: devices that seed the same values with
   * the same `seed` produce states that merge as one.
   */
  seed(fields: readonly string[], values: readonly string[], seed: number): string;
};

const engines = new WeakMap<z.ZodType, TextEngine>();

/** Called by a text helper such as `yText()` on the schema it returns. */
export function registerTextField(schema: z.ZodType, engine: TextEngine): void {
  engines.set(schema, engine);
}

export function textEngineOf(schema: z.ZodType): TextEngine | undefined {
  return engines.get(schema);
}
