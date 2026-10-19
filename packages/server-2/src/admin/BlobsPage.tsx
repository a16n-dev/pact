import { AppShell } from './ui/AppShell';
import type { AppRow } from '../db/apps';
import type { BlobRow } from '../db/blobs';
import { formatBytes, formatCount, formatDate, shortHash } from './format';

export type BlobsPageProps = {
  app: AppRow;
  blobs: BlobRow[];
  stats: { count: number; bytes: number };
  nextCursor?: string;
};

export function BlobsPage({ app, blobs, stats, nextCursor }: BlobsPageProps) {
  return (
    <AppShell app={app} tab='blobs'>
      <div class='page-head'>
        <h1>Blobs</h1>
        <span class='muted'>
          {formatCount(stats.count)} blobs · {formatBytes(stats.bytes)}
        </span>
      </div>
      <div class='card'>
        <div class='table-scroll'>
          <table>
            <thead>
              <tr>
                <th>Hash</th>
                <th>Type</th>
                <th class='right'>Size</th>
                <th>Uploaded</th>
                <th>
                  <span class='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {blobs.length === 0 ? (
                <tr class='empty'>
                  <td colspan={5}>Blobs show up here once a device uploads one.</td>
                </tr>
              ) : null}
              {blobs.map((blob) => (
                <tr>
                  <td class='mono' title={blob.hash}>
                    {shortHash(blob.hash)}
                  </td>
                  <td class='muted'>{blob.mime_type}</td>
                  <td class='right'>{formatBytes(blob.size)}</td>
                  <td class='muted'>{formatDate(blob.created_at)}</td>
                  <td class='actions'>
                    <a href={`/admin/apps/${app.id}/blobs/${blob.hash}`}>Download</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextCursor ? (
          <div class='load-more'>
            <a class='btn btn-ghost' href={`/admin/apps/${app.id}/blobs?after=${nextCursor}`}>
              Load more
            </a>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
