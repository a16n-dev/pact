import { AppShell } from './ui/AppShell';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import type { AppRow } from '../db/apps';
import { formatBytes, formatCount } from './format';
import { X } from 'lucide';
import { Icon } from '../ui/Icon';

export type SettingsPageProps = {
  app: AppRow;
  redirectUris: string[];
  counts: { documents: number; blobs: number; blobBytes: number; tokens: number };
  dialog?: { id: SettingsDialogId; value?: string; error?: string };
};

export type SettingsDialogId = 'rename' | 'add-uri' | 'delete';

export function SettingsPage({ app, redirectUris, counts, dialog }: SettingsPageProps) {
  const base = `/admin/apps/${app.id}`;
  const errorFor = (id: SettingsDialogId) => (dialog?.id === id ? dialog.error : undefined);
  return (
    <AppShell app={app} tab='settings' narrow>
      <section class='card' aria-labelledby='h-general'>
        <div class='card-head'>
          <h2 id='h-general'>General</h2>
        </div>
        <div class='card-row'>
          <div>
            <div class='label'>Name</div>
            <div>{app.name}</div>
          </div>
          <button type='button' class='btn' data-opens='rename'>
            Rename
          </button>
        </div>
        <div class='card-row'>
          <div>
            <div class='label'>App ID</div>
            <div class='mono'>{app.id}</div>
          </div>
        </div>
      </section>

      <section class='card' aria-labelledby='h-redirects'>
        <div class='card-head'>
          <div>
            <h2 id='h-redirects'>Redirect URIs</h2>
            <p>
              Sign-in can only send people back to these addresses. For local development, a{' '}
              <code>localhost</code> address works on any port.
            </p>
          </div>
          <button type='button' class='btn' data-opens='add-uri'>
            Add URI
          </button>
        </div>
        <ul class='uris'>
          {redirectUris.length === 0 ? (
            <li class='empty'>Add a redirect URI before anyone can sign in to this app.</li>
          ) : null}
          {redirectUris.map((uri) => (
            <li>
              <span class='uri'>{uri}</span>
              <form method='post' action={`${base}/redirect-uris/remove`}>
                <input type='hidden' name='uri' value={uri} />
                <button type='submit' class='btn btn-ghost btn-icon' aria-label={`Remove ${uri}`}>
                  <Icon icon={X} size={16} />
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section class='card' aria-labelledby='h-danger'>
        <div class='card-head'>
          <h2 id='h-danger'>Danger zone</h2>
        </div>
        <div class='card-row'>
          <div>
            <div class='title'>Wipe data</div>
            <div class='muted small'>
              Deletes every document and blob but keeps the app, its settings and its tokens.
            </div>
          </div>
          <button type='button' class='btn btn-danger' data-opens='wipe'>
            Wipe data
          </button>
        </div>
        <div class='card-row'>
          <div>
            <div class='title'>Delete app</div>
            <div class='muted small'>
              Deletes the app and all of its data, and revokes every token.
            </div>
          </div>
          <button type='button' class='btn btn-danger-filled' data-opens='delete'>
            Delete app
          </button>
        </div>
      </section>

      <Dialog
        id='rename'
        title='Rename app'
        action={`${base}/rename`}
        submitLabel='Rename'
        open={dialog?.id === 'rename'}
      >
        <Field
          id='name'
          label='Name'
          value={dialog?.id === 'rename' ? dialog.value : app.name}
          error={errorFor('rename')}
        />
      </Dialog>
      <Dialog
        id='add-uri'
        title='Add redirect URI'
        action={`${base}/redirect-uris`}
        submitLabel='Add URI'
        open={dialog?.id === 'add-uri'}
      >
        <Field
          id='uri'
          label='Redirect URI'
          mono
          value={dialog?.id === 'add-uri' ? dialog.value : undefined}
          error={errorFor('add-uri')}
          help='An https address, a localhost address, or a custom scheme like com.example.app:/callback.'
        />
      </Dialog>
      <Dialog
        id='wipe'
        title={`Wipe ${app.name}?`}
        description={`This permanently deletes ${formatCount(counts.documents)} documents and ${formatCount(counts.blobs)} blobs (${formatBytes(counts.blobBytes)}). Devices stay signed in and start again from empty.`}
        action={`${base}/wipe`}
        submitLabel='Wipe data'
        submitClass='btn-danger-filled'
      />
      <Dialog
        id='delete'
        title={`Delete ${app.name}?`}
        description={`This permanently deletes ${formatCount(counts.documents)} documents and ${formatCount(counts.blobs)} blobs (${formatBytes(counts.blobBytes)}), and revokes all ${formatCount(counts.tokens)} tokens.`}
        action={`${base}/delete`}
        submitLabel='Delete app'
        submitClass='btn-danger-filled'
        open={dialog?.id === 'delete'}
        closable={false}
      >
        <Field id='confirm' label='' mono value='' error={errorFor('delete')}>
          Type <code style='color: var(--hz-text)'>{app.id}</code> to confirm
        </Field>
      </Dialog>
    </AppShell>
  );
}
