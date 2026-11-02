import { describe, it, expect } from 'vitest';

// Every statement against a tenant table must scope by app_id. The SQL is inline at its call
// site, so this reads the data layer's source and picks out each string literal passed to
// `prepare` that touches a tenant table.
const sources = import.meta.glob('../src/db/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function tenantStatements(source: string): string[] {
  return [...source.matchAll(/\.prepare\(\s*(['`])([\s\S]*?)\1\s*\)/g)]
    .map((m) => m[2]!)
    .filter((sql) => /\b(documents|blobs)\b/.test(sql));
}

describe('tenant isolation tripwire', () => {
  it('every statement on documents or blobs filters on app_id', () => {
    const statements = Object.values(sources).flatMap((s) => tenantStatements(s as string));
    expect(statements.length).toBeGreaterThanOrEqual(9);
    for (const sql of statements) expect(sql).toContain('app_id');
  });
});
