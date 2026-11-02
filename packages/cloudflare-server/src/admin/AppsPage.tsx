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
        <div>
          <h1>Apps</h1>
          <p>Each app gets its own documents, blobs and tokens on this server.</p>
        </div>
        <button type='button' class='btn btn-primary' data-opens='new-app'>
          <Icon icon={Plus} size={16} />
          New app
        </button>
      </div>
      {apps.length === 0 ? (
        <div class='card empty-card'>Create an app to give it a place to sync.</div>
      ) : null}
      <div class='app-list'>
        {apps.map((app) => (
          <article class='card app-card'>
            <div class='app-card-main'>
              <div>
                <a href={`/admin/apps/${app.id}/documents`} class='app-name'>
                  {app.name}
                </a>
                <div class='mono muted small'>{app.id}</div>
              </div>
              <span class='muted small'>Created {formatDate(app.created_at)}</span>
            </div>
            <div class='app-card-foot'>
              <span>{formatCount(app.document_count)} documents</span>
              <span>{app.blob_bytes === 0 ? 'No blobs' : formatBytes(app.blob_bytes)}</span>
            </div>
          </article>
        ))}
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
