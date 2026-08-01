import { describe, it, expect } from 'vitest';
import { packBackup, unpackBackup, BACKUP_FORMAT_VERSION, type BackupManifest } from '../src/backup/archive';
import type { BaseDocument } from '../src/types';

function doc(id: string, extra: Record<string, unknown> = {}): BaseDocument {
  return {
    id,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'us/1',
    updatedBy: 'us/1',
    deletedAt: null,
    deletedBy: null,
    ...extra,
  } as BaseDocument;
}

describe('packBackup / unpackBackup', () => {
  it('round-trips a manifest with documents and no blobs', () => {
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: '2026-06-17T00:00:00.000Z',
      collections: {
        widgets: [
          doc('wg-1', { name: 'Alpha' }),
          doc('wg-2', { name: 'Beta', deletedAt: '2026-02-01T00:00:00.000Z' }),
        ],
      },
    };
    const { manifest: out, blobs } = unpackBackup(packBackup(manifest, []));
    expect(out).toEqual(manifest);
    expect(blobs).toEqual([]);
  });

  it('round-trips blob bytes verbatim, including non-text payloads', () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 128, 0, 42]);
    const archive = packBackup(
      { formatVersion: BACKUP_FORMAT_VERSION, createdAt: 'x', collections: {} },
      [{ hash: 'abc123', mimeType: 'image/png', bytes }]
    );
    const { blobs } = unpackBackup(archive);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({ hash: 'abc123', mimeType: 'image/png' });
    expect(Array.from(blobs[0].bytes)).toEqual(Array.from(bytes));
  });

  it('rejects bytes that are not a backup', () => {
    expect(() => unpackBackup(Uint8Array.from([1, 2, 3, 4, 5]))).toThrow(/not a pact backup/i);
  });

  it('rejects an unsupported format version', () => {
    const archive = packBackup(
      { formatVersion: BACKUP_FORMAT_VERSION + 1, createdAt: 'x', collections: {} },
      []
    );
    expect(() => unpackBackup(archive)).toThrow(/format version/i);
  });

  it('rejects a truncated container', () => {
    const archive = packBackup(
      {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: 'x',
        collections: { widgets: [doc('wg-1')] },
      },
      []
    );
    expect(() => unpackBackup(archive.slice(0, archive.length - 5))).toThrow(/corrupt backup/i);
  });
});
