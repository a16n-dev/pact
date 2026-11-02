import { AppShell } from './ui/AppShell';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import type { AppRow } from '../db/apps';
import type { AppUser } from '../db/appUsers';
import type { UserSummary } from '../db/users';
import type { ApiTokenSummary, DeviceTokenSummary } from '../db/tokens';
import { formatDate, formatRelative } from './format';
import { Copy, Plus, TriangleAlert, X } from 'lucide';
import { Icon } from '../ui/Icon';

export type AccessPageProps = {
  app: AppRow;
  allowed: AppUser[];
  users: UserSummary[];
  api: ApiTokenSummary[];
  devices: DeviceTokenSummary[];
  addUser?: { error: string };
  mint?: { open: boolean; label?: string; error?: string };
  minted?: { label: string; token: string };
};

export function AccessPage({
  app,
  allowed,
  users,
  api,
  devices,
  addUser,
  mint,
  minted,
}: AccessPageProps) {
  const base = `/admin/apps/${app.id}/access`;
  const restricted = app.restricted === 1;
  const allowedIds = new Set(allowed.map((user) => user.id));
  const candidates = users.filter((user) => !allowedIds.has(user.id));
  return (
    <AppShell app={app} tab='access'>
      <section class='card' aria-labelledby='h-access'>
        <div class='card-head'>
          <div>
            <h2 id='h-access'>Who can sign in</h2>
            <p>Sign-in is open to every user on this server until you restrict it.</p>
          </div>
          <button
            type='button'
            class='btn'
            data-opens='add-user'
            disabled={candidates.length === 0}
          >
            <Icon icon={Plus} size={16} />
            Add user
          </button>
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

      <section class='card' aria-labelledby='h-devices'>
        <div class='card-head'>
          <div>
            <h2 id='h-devices'>Signed-in devices</h2>
            <p>Signing a device out cuts off its access straight away. Anything it synced stays.</p>
          </div>
        </div>
        <div class='table-scroll'>
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Device</th>
                <th>Signed in</th>
                <th>Last seen</th>
                <th>
                  <span class='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 ? (
                <tr class='empty'>
                  <td colspan={5}>Devices appear here once someone signs in to this app.</td>
                </tr>
              ) : null}
              {devices.map((token) => (
                <tr>
                  <td class='strong'>{token.username}</td>
                  <td>{token.label}</td>
                  <td class='muted'>{formatDate(token.created_at)}</td>
                  <td>{formatRelative(token.last_seen_at)}</td>
                  <td class='actions'>
                    <button type='button' class='btn btn-danger' data-opens={`revoke-${token.id}`}>
                      Sign out
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class='card' aria-labelledby='h-api'>
        <div class='card-head'>
          <div>
            <h2 id='h-api'>API tokens</h2>
            <p>For scripts and integrations that need access without a user account.</p>
          </div>
          <button type='button' class='btn' data-opens='mint'>
            <Icon icon={Plus} size={16} />
            Mint API token
          </button>
        </div>
        <div class='table-scroll'>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Token</th>
                <th>Created</th>
                <th>Last used</th>
                <th>
                  <span class='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {api.length === 0 ? (
                <tr class='empty'>
                  <td colspan={5}>Mint a token to let a script or integration use this app.</td>
                </tr>
              ) : null}
              {api.map((token) => (
                <tr>
                  <td class='strong'>{token.label}</td>
                  <td class='mono muted'>{token.token_prefix}…</td>
                  <td class='muted'>{formatDate(token.created_at)}</td>
                  <td>{formatRelative(token.last_seen_at)}</td>
                  <td class='actions'>
                    <button type='button' class='btn btn-danger' data-opens={`revoke-${token.id}`}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog
        id='add-user'
        title='Add user'
        description='Removing a user later signs them out of this app on every device.'
        action={`${base}/users`}
        submitLabel='Add user'
        open={addUser !== undefined}
      >
        <div class='field'>
          <label for='user_id'>User</label>
          <select id='user_id' name='user_id' required aria-invalid={addUser ? 'true' : undefined}>
            {candidates.map((user) => (
              <option value={user.id}>{user.username}</option>
            ))}
          </select>
          {addUser ? (
            <span class='error' role='alert'>
              {addUser.error}
            </span>
          ) : null}
        </div>
      </Dialog>
      <Dialog
        id='mint'
        title='Mint API token'
        description={`Gives a script or integration full read and write access to ${app.name}.`}
        action={`${base}/tokens`}
        submitLabel='Mint API token'
        open={mint?.open}
      >
        <Field
          id='label'
          label='Label'
          value={mint?.label}
          error={mint?.error}
          help="Pick something you'll recognise later, like the script's name."
        />
      </Dialog>

      {minted ? (
        <dialog id='minted' class='wide' data-autoopen=''>
          <form method='dialog'>
            <div class='dialog-head'>
              <h2>Here's your API token</h2>
            </div>
            <div class='field'>
              <label for='minted-token'>{minted.label}</label>
              <div class='token-row'>
                <input id='minted-token' class='mono' readonly value={minted.token} />
                <button type='button' class='btn' data-copy='minted-token'>
                  <Icon icon={Copy} size={16} />
                  <span>Copy</span>
                </button>
              </div>
            </div>
            <div class='alert'>
              <Icon icon={TriangleAlert} size={18} color='var(--hz-muted)' />
              <span>
                Copy this now, because you won't be able to see it again. If it gets lost, revoke it
                and mint a new one.
              </span>
            </div>
            <div class='dialog-actions'>
              <button type='submit' class='btn btn-primary'>
                Done
              </button>
            </div>
          </form>
        </dialog>
      ) : null}

      {api.map((token) => (
        <Dialog
          id={`revoke-${token.id}`}
          title={`Revoke ${token.label}?`}
          description='Anything using this token loses access straight away.'
          action={`${base}/tokens/${token.id}/revoke`}
          submitLabel='Revoke token'
          submitClass='btn-danger-filled'
        />
      ))}
      {devices.map((token) => (
        <Dialog
          id={`revoke-${token.id}`}
          title={`Sign out ${token.label}?`}
          description={`${token.username} will need to sign in again on this device. Anything it synced stays.`}
          action={`${base}/tokens/${token.id}/revoke`}
          submitLabel='Sign out device'
          submitClass='btn-danger-filled'
        />
      ))}
    </AppShell>
  );
}
