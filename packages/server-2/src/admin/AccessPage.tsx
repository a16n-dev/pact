import { AppShell } from './ui/AppShell';
import { Dialog } from '../ui/Dialog';
import type { AppRow } from '../db/apps';
import type { AppUser } from '../db/appUsers';
import type { UserSummary } from '../db/users';
import { Plus, X } from 'lucide';
import { Icon } from '../ui/Icon';

export type AccessPageProps = {
  app: AppRow;
  allowed: AppUser[];
  users: UserSummary[];
  dialog?: { error: string };
};

export function AccessPage({ app, allowed, users, dialog }: AccessPageProps) {
  const base = `/admin/apps/${app.id}/access`;
  const restricted = app.restricted === 1;
  const allowedIds = new Set(allowed.map((user) => user.id));
  const candidates = users.filter((user) => !allowedIds.has(user.id));
  return (
    <AppShell
      app={app}
      tab='access'
      narrow
      actions={
        <button
          type='button'
          class='btn btn-primary'
          data-opens='add-user'
          disabled={candidates.length === 0}
        >
          <Icon icon={Plus} size={16} />
          Add user
        </button>
      }
    >
      <section class='card' aria-labelledby='h-access'>
        <div class='card-head'>
          <div>
            <h2 id='h-access'>Who can sign in</h2>
            <p>Sign-in is open to every user on this server until you restrict it.</p>
          </div>
        </div>
        <div class='card-row'>
          <div>
            <div class='title'>Restrict access</div>
            <div class='muted small'>
              Only the users listed here can sign in. Anyone already signed in is added to the list
              when you turn this on.
            </div>
          </div>
          <form method='post' action={`${base}/restrict`} data-autosubmit>
            <label class='switch'>
              <input
                type='checkbox'
                name='enabled'
                checked={restricted}
                aria-label='Restrict access'
              />
              <span class='switch-track' aria-hidden='true' />
            </label>
          </form>
        </div>
        <ul class={restricted ? 'uris' : 'uris inactive'} aria-label='Allowed users'>
          {allowed.length === 0 ? (
            <li class='empty'>
              {restricted
                ? 'Nobody can sign in until you add a user.'
                : 'Add users here, then turn on Restrict access.'}
            </li>
          ) : null}
          {allowed.map((user) => (
            <li>
              <span class='uri'>{user.username}</span>
              <form method='post' action={`${base}/users/remove`}>
                <input type='hidden' name='user_id' value={user.id} />
                <button
                  type='submit'
                  class='btn btn-ghost btn-icon'
                  aria-label={`Remove ${user.username}`}
                >
                  <Icon icon={X} size={16} />
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        id='add-user'
        title='Add user'
        description='Removing a user later signs them out of this app on every device.'
        action={`${base}/users`}
        submitLabel='Add user'
        open={dialog !== undefined}
      >
        <div class='field'>
          <label for='user_id'>User</label>
          <select id='user_id' name='user_id' required aria-invalid={dialog ? 'true' : undefined}>
            {candidates.map((user) => (
              <option value={user.id}>{user.username}</option>
            ))}
          </select>
          {dialog ? (
            <span class='error' role='alert'>
              {dialog.error}
            </span>
          ) : null}
        </div>
      </Dialog>
    </AppShell>
  );
}
