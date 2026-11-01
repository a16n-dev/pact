import { AppShell } from './ui/AppShell';
import type { AppRow } from '../db/apps';
import type { DocumentSummary } from '../db/documents';
import { formatBytes, formatClock, formatCount } from './format';

export type CollectionPageProps = {
  app: AppRow;
  collection: string;
  stats: { document_count: number; data_bytes: number };
  documents: DocumentSummary[];
  nextCursor?: string;
};

export function CollectionPage({
  app,
  collection,
  stats,
  documents,
  nextCursor,
}: CollectionPageProps) {
  const base = `/admin/apps/${app.id}/documents/${encodeURIComponent(collection)}`;
  return (
    <AppShell app={app} tab='documents' trail={[{ label: collection }]}>
      <div class='card'>
        <div class='card-head'>
          <div>
            <h2 class='mono'>{collection}</h2>
            <p>
              {formatCount(stats.document_count)} documents · {formatBytes(stats.data_bytes)}
            </p>
          </div>
        </div>
        <div class='table-scroll'>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th class='right'>Versions</th>
                <th>Last written</th>
                <th class='right'>Data</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr>
                  <td class='mono strong'>
                    <a href={`${base}/${encodeURIComponent(doc.id)}`}>{doc.id}</a>
                  </td>
                  <td class='right'>{formatCount(doc.version_count)}</td>
                  <td class='muted' title={doc.hlc}>
                    {formatClock(doc.hlc)}
                  </td>
                  <td class='right'>{formatBytes(doc.data_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextCursor ? (
          <div class='load-more'>
            <a class='btn btn-ghost' href={`${base}?after=${encodeURIComponent(nextCursor)}`}>
              Load more
            </a>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
