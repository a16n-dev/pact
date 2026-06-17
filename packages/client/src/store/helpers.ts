import type { BaseDocument } from '../types';

/** Field-wise equality ignoring audit timestamps — used to skip seed writes
 *  that would change nothing but `updatedAt`. */
export function seedContentEqual(a: BaseDocument, b: BaseDocument): boolean {
  const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: BaseDocument) => rest;
  return deepEqual(strip(a), strip(b));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}
