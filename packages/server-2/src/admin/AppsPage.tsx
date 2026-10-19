import { AdminShell } from './ui/AdminShell';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import type { AppSummary } from '../db/apps';
import { formatBytes, formatCount, formatDate } from './format';
import { Plus } from 'lucide';
import { Icon } from '../ui/Icon';

export type AppsPageProps = {
  apps: AppSummary[];
  dialog?: { open: boolean; name?: string; id?: string; error?: string };
};

export function AppsPage({ apps, dialog }: AppsPageProps) {
  return (
    <AdminShell title='Apps' section='apps'>
      <div class='page-head'>
        <h1>Apps</h1>
        <button type='button' class='btn btn-primary' data-opens='new-app'>
          <Icon icon={Plus} size={16} />
          New app
        </button>
      </div>
      <div class='card table-scroll'>
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
              <tr class='empty'>
                <td colspan={6}>Create an app to give it a place to sync.</td>
              </tr>
            ) : null}
            {apps.map((app) => (
              <tr>
                <td class='strong'>
                  <a href={`/admin/apps/${app.id}/blobs`} class='plain'>
                    {app.name}
                  </a>
                </td>
                <td class='mono muted'>{app.id}</td>
                <td class='right'>{formatCount(app.token_count)}</td>
                <td class='right'>{formatCount(app.document_count)}</td>
                <td class='right'>{formatBytes(app.blob_bytes)}</td>
                <td class='muted'>{formatDate(app.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
