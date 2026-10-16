import { AppShell } from './ui/AppShell';
import type { AppRow } from '../db/apps';
import type { BlobRow } from '../db/blobs';
import { formatBytes, formatCount, formatDate, shortHash } from './format';
import { File, Image } from 'lucide';
import { Icon } from '../ui/Icon';

export type BlobsPageProps = {
  host: string;
  app: AppRow;
  blobs: BlobRow[];
  stats: { count: number; bytes: number };
  nextCursor?: string;
};

export function BlobsPage({ host, app, blobs, stats, nextCursor }: BlobsPageProps) {
  return (
    <AppShell host={host} app={app} tab='blobs'>
      <div class='row spread'>
        <h2>Blobs</h2>
        <span class='muted small'>
          {formatCount(stats.count)} blobs · {formatBytes(stats.bytes)}
        </span>
      </div>
      <div class='table-box'>
        <table>
          <thead>
            <tr>
              <th style='width: 56px'>
                <span class='sr-only'>Type</span>
              </th>
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
              <tr>
                <td colspan={6} class='empty'>
                  Blobs show up here once a device uploads one.
                </td>
              </tr>
            ) : null}
            {blobs.map((blob) => (
              <tr>
                <td>
                  <div class='thumb' aria-hidden='true'>
                    {blob.mime_type.startsWith('image/') ? (
                      <Icon icon={Image} />
                    ) : (
                      <Icon icon={File} />
                    )}
                  </div>
                </td>
                <td class='mono small' title={blob.hash}>
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
