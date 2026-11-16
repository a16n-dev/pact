import type { Text as YText } from 'yjs';
import type { BaseDocument } from '../types';
import type { IdKind } from '../collection';
import type { IndexKeyInput } from './indexes';

/**
 * Write shape: every field but the base ones, in the schema's input form so
 * defaulted fields are optional. Text fields take a string, written as the
 * minimal edit from the current text.
 */
export type DocumentInput<T extends BaseDocument> = Omit<T, keyof BaseDocument>;

// Distributes over the `IdKind` union, so a collection whose kind is not
// statically known accepts either shape.
type CreateInput<T extends BaseDocument, Input, Ids extends IdKind> = Ids extends 'slug'
  ? Input & { id: T['id'] }
  : Input & { id?: T['id'] };

/**
 * Obtained via `store.collection(name)`. The document type, `IndexNames`,
 * `TextFields` and `Input` are inferred from that collection's definition;
 * the names are `string` when the collection is not statically known.
 */
export type Collection<
  T extends BaseDocument,
  IndexNames extends string = string,
  TextFields extends string = string,
  Input extends object = DocumentInput<T>,
  Ids extends IdKind = IdKind,
> = {
  /**
   * Soft-deleted docs read as null unless `includeDeleted` is set; then
   * inspect `deletedAt` to tell a tombstone from a live doc.
   */
  get(id: string, opts?: { includeDeleted?: boolean }): Promise<T | null>;
  /** In input order, minus any missing or soft-deleted. */
  getMany(ids: readonly string[]): Promise<T[]>;
  /** Live docs only unless `includeDeleted` is set. */
  list(opts?: { includeDeleted?: boolean }): Promise<T[]>;
  /**
   * Live docs whose extractor emitted `key`. Equality only; order is
   * unspecified. Matches are re-read through the store, so results are
   * migrated, validated, and tombstone-free even if the index momentarily
   * lags a write. Throws on an unknown index name.
   */
  listByIndex(index: IndexNames, key: IndexKeyInput): Promise<T[]>;
  /** Random-id collections generate the id unless supplied; slug-id collections require it. */
  create(input: CreateInput<T, Input, Ids>): Promise<T>;
  createMany(items: Array<CreateInput<T, Input, Ids>>): Promise<T[]>;
  /**
   * The live doc at `id` if there is one, untouched; otherwise the doc is
   * created. A soft-deleted doc counts as absent and is revived with these fields.
   */
  getOrCreate(input: Input & { id: T['id'] }): Promise<T>;
  /** A partial merge: fields you omit keep their value and clock. Throws when the doc does not exist. */
  update(id: string, input: Partial<Input>): Promise<T>;
  updateMany(updates: Array<{ id: string } & Partial<Input>>): Promise<T[]>;
  /** A soft-deleted doc counts as absent: upserting its id revives it as a fresh doc. */
  upsert(input: Input & { id: T['id'] }): Promise<T>;
  /** Soft-delete; the tombstone remains and syncs so other devices converge. */
  delete(id: string): Promise<void>;
  deleteMany(ids: readonly string[]): Promise<void>;
  /**
   * The live Yjs text for a text field, owned by the store: the same instance
   * comes back while the document is loaded, every transaction on it is
   * persisted at once, and merges from other devices land in it. Throws
   * when the document does not exist.
   *
   * Compaction, here or on another device, replaces the document: the old
   * `Y.Doc` is destroyed (its `destroy` event fires) and edits to it are
   * dropped, so an editor binding should fetch the new text and rebind.
   */
  text(id: string, field: TextFields): Promise<YText>;
  /**
   * Writes a text field from an editor that hands over its content after
   * the fact: the edits from `base` (the text the editor started from) to
   * `next` apply on top of whatever has merged in since, instead of
   * overwriting it. Where both sides changed the same span, both changes are
   * kept. Throws when the doc does not exist.
   */
  updateText(id: string, field: TextFields, change: { base: string; next: string }): Promise<T>;
  /**
   * Rebuilds the document's text state from its current strings, dropping
   * edit history that otherwise only grows. It happens on its own once the
   * state is large relative to the text; call this to force it. Pulls the
   * document first when signed in, and throws if that fails.
   */
  compactText(id: string): Promise<void>;
};
