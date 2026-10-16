import { AdminShell } from './AdminShell';
import { Dialog } from './Dialog';
import { Field } from './Field';
import type { AppSummary } from '../db/apps';
import { formatBytes, formatCount, formatDate } from './format';

export type AppsPageProps = {
  host: string;
  apps: AppSummary[];
  dialog?: { open: boolean; name?: string; id?: string; error?: string };
};

export function AppsPage({ host, apps, dialog }: AppsPageProps) {
  return (
    <AdminShell title='Apps' host={host} section='apps'>
      <main class='container'>
        <div class='row spread'>
          <h1>Apps</h1>
          <button type='button' class='btn btn-primary' data-opens='new-app'>
            New app
          </button>
        </div>
        <div class='table-box'>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>App ID</th>
                <th class='right'>Tokens</th>
                <th class='right'>Documents</th>
                <th class='right'>Blobs</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {apps.length === 0 ? (
                <tr>
                  <td colspan={6} class='empty'>
                    Create an app to give it a place to sync.
                  </td>
                </tr>
              ) : null}
              {apps.map((app) => (
                <tr>
                  <td>
                    <a
                      href={`/admin/apps/${app.id}/blobs`}
                      style='color: inherit; font-weight: 500; text-decoration: none'
                    >
                      {app.name}
                    </a>
                  </td>
                  <td class='mono muted small'>{app.id}</td>
                  <td class='right'>{formatCount(app.token_count)}</td>
                  <td class='right'>{formatCount(app.document_count)}</td>
                  <td class='right'>{formatBytes(app.blob_bytes)}</td>
                  <td class='muted'>{formatDate(app.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <Dialog
        id='new-app'
        title='New app'
        action='/admin/apps'
        submitLabel='Create app'
        open={dialog?.open}
      >
        <Field id='name' label='Name' value={dialog?.name} />
        <Field
          id='id'
          label='App ID'
          value={dialog?.id}
          mono
          error={dialog?.error}
          help="Use lowercase letters, numbers, hyphens and underscores. You can't change this later."
        />
      </Dialog>
    </AdminShell>
  );
}
