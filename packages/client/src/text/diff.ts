import diff from 'fast-diff';

/** Deletes `deleteCount` characters at `index`, then inserts `insert` there. */
export type TextSplice = { index: number; deleteCount: number; insert: string };

// Last first, so each splice's index still holds after the ones before it apply.
export function textSplices(from: string, to: string): TextSplice[] {
  const splices: TextSplice[] = [];
  let index = 0;
  let pending: TextSplice | null = null;
  for (const [op, chunk] of diff(from, to, undefined, true)) {
    if (op === diff.EQUAL) {
      if (pending) splices.push(pending);
      pending = null;
      index += chunk.length;
      continue;
    }
    pending ??= { index, deleteCount: 0, insert: '' };
    if (op === diff.DELETE) {
      pending.deleteCount += chunk.length;
      index += chunk.length;
    } else pending.insert += chunk;
  }
  if (pending) splices.push(pending);
  return splices.reverse();
}

// Describes `edited` relative to `base`: which base characters it keeps, and
// the text it inserts in each gap (gap `i` sits before base character `i`).
function layout(base: string, edited: string): { kept: boolean[]; inserts: string[] } {
  const kept = new Array<boolean>(base.length).fill(true);
  const inserts = new Array<string>(base.length + 1).fill('');
  let at = 0;
  for (const [op, chunk] of diff(base, edited, undefined, true)) {
    if (op === diff.INSERT) inserts[at] += chunk;
    else {
      if (op === diff.DELETE) kept.fill(false, at, at + chunk.length);
      at += chunk.length;
    }
  }
  return { kept, inserts };
}

// Three-way merge: applies the `base → next` edits on top of `current`, a
// later version of `base`. A character either side deleted is gone; text
// both sides inserted in the same place lands once; anything else both
// sides inserted is kept.
export function rebaseText(base: string, current: string, next: string): string {
  if (current === base || next === current) return next;
  if (next === base) return current;
  const theirs = layout(base, current);
  const ours = layout(base, next);
  let out = '';
  for (let i = 0; i <= base.length; i++) {
    out += theirs.inserts[i];
    if (ours.inserts[i] !== theirs.inserts[i]) out += ours.inserts[i];
    if (i < base.length && theirs.kept[i] && ours.kept[i]) out += base[i];
  }
  return out;
}
