import { describe, it, expect } from 'vitest';
import { DOCUMENT_SQL } from '../src/db/documents';
import { BLOB_SQL } from '../src/db/blobs';

describe('tenant isolation tripwire', () => {
  it('every data SQL statement filters on app_id', () => {
    const statements = [...DOCUMENT_SQL, ...BLOB_SQL];
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql).toContain('app_id');
  });
});
