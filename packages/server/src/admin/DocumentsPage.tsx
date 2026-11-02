import { AppShell } from './ui/AppShell';
import type { AppRow } from '../db/apps';
import type { DocumentStats } from '../db/documents';
import { formatBytes, formatCount } from './format';

export type DocumentsPageProps = { app: AppRow; stats: DocumentStats };

export function DocumentsPage({ app, stats }: DocumentsPageProps) {
  const tiles = [
    { label: 'Documents', value: formatCount(stats.document_count) },
    { label: 'Versions', value: formatCount(stats.version_count) },
    { label: 'Writers', value: formatCount(stats.writer_count) },
    { label: 'Data', value: formatBytes(stats.data_bytes) },
  ];
  return (
    <AppShell app={app} tab='documents'>
      <div class='stats'>
        {tiles.map((tile) => (
          <div class='card stat'>
            <div class='stat-label'>{tile.label}</div>
            <div class='stat-value'>{tile.value}</div>
          </div>
        ))}
      </div>
      <div class='card'>
        <div class='card-head'>
          <div>
            <h2>Collections</h2>
            <p>Each document is stored as one version per device or token that has written it.</p>
          </div>
        </div>
        <div class='table-scroll'>
          <table>
            <thead>
              <tr>
                <th>Collection</th>
                <th class='right'>Documents</th>
                <th class='right'>Versions</th>
                <th class='right'>Data</th>
              </tr>
            </thead>
            <tbody>
              {stats.collections.length === 0 ? (
                <tr class='empty'>
                  <td colspan={4}>Documents show up here once a device pushes some.</td>
                </tr>
              ) : null}
              {stats.collections.map((row) => (
                <tr>
                  <td class='mono strong'>
                    <a
                      href={`/admin/apps/${app.id}/documents/${encodeURIComponent(row.collection)}`}
                    >
                      {row.collection}
                    </a>
                  </td>
                  <td class='right'>{formatCount(row.document_count)}</td>
                  <td class='right'>{formatCount(row.version_count)}</td>
                  <td class='right'>{formatBytes(row.data_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
