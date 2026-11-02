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
  origins: string[];
  counts: { documents: number; blobs: number; blobBytes: number; tokens: number };
  dialog?: { id: SettingsDialogId; value?: string; error?: string };
};

export type SettingsDialogId = 'rename' | 'add-uri' | 'add-origin' | 'delete';

export function SettingsPage({ app, redirectUris, origins, counts, dialog }: SettingsPageProps) {
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
            <p>Sign-in can only send people back to these addresses.</p>
          </div>
          <button type='button' class='btn' data-opens='add-uri'>
            Add URI
          </button>
        </div>
        <div class='card-row'>
          <div>
            <div class='title'>Allow localhost</div>
            <div class='muted small'>
              Lets local builds sign in from any <code>http://localhost</code> or{' '}
              <code>http://127.0.0.1</code> address on any port.
            </div>
          </div>
          <form method='post' action={`${base}/localhost`} data-autosubmit>
            <label class='switch'>
              <input
                type='checkbox'
                name='enabled'
                checked={app.allow_localhost === 1}
                aria-label='Allow localhost'
              />
              <span class='switch-track' aria-hidden='true' />
            </label>
          </form>
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

      <section class='card' aria-labelledby='h-origins'>
        <div class='card-head'>
          <div>
            <h2 id='h-origins'>App domains</h2>
            <p>
              Browsers on these domains can call the API. Localhost always can, and adding an https
              redirect URI adds its domain here too.
            </p>
          </div>
          <button type='button' class='btn' data-opens='add-origin'>
            Add domain
          </button>
        </div>
        <ul class='uris'>
          {origins.length === 0 ? (
            <li class='empty'>Add a domain before a web app hosted there can sync.</li>
          ) : null}
          {origins.map((origin) => (
            <li>
              <span class='uri'>{origin}</span>
              <form method='post' action={`${base}/origins/remove`}>
                <input type='hidden' name='origin' value={origin} />
                <button
                  type='submit'
                  class='btn btn-ghost btn-icon'
                  aria-label={`Remove ${origin}`}
                >
                  <Icon icon={X} size={16} />
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section class='card' aria-labelledby='h-ai'>
        <div class='card-head'>
          <h2 id='h-ai'>AI</h2>
        </div>
        <div class='card-row'>
          <div>
            <div class='title'>AI proxy</div>
            <div class='muted small'>
              Lets this app call AI providers through the server's AI Gateway at <code>/ai</code>.
            </div>
          </div>
          <form method='post' action={`${base}/ai-proxy`} data-autosubmit>
            <label class='switch'>
              <input
                type='checkbox'
                name='enabled'
                checked={app.ai_proxy === 1}
                aria-label='AI proxy'
              />
              <span class='switch-track' aria-hidden='true' />
            </label>
          </form>
        </div>
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
          help='An https address or a custom scheme like com.example.app:/callback.'
        />
      </Dialog>
      <Dialog
        id='add-origin'
        title='Add app domain'
        action={`${base}/origins`}
        submitLabel='Add domain'
        open={dialog?.id === 'add-origin'}
      >
        <Field
          id='domain'
          label='Domain'
          mono
          value={dialog?.id === 'add-origin' ? dialog.value : undefined}
          error={errorFor('add-origin')}
          help='Just the host, like app.example.com. It must be served over https.'
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
