import { AdminShell } from './ui/AdminShell';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import type { UserSummary } from '../db/users';
import { formatCount, formatDate } from './format';

export type UsersPageProps = {
  host: string;
  users: UserSummary[];
  dialog?: { id: string; username?: string; error?: string };
};

export function UsersPage({ host, users, dialog }: UsersPageProps) {
  return (
    <AdminShell title='Users' host={host} section='users'>
      <main class='container'>
        <div class='row spread'>
          <div class='stack' style='gap: 6px'>
            <h1>Users</h1>
            <p class='muted'>Everyone here can sign in to any app on this server.</p>
          </div>
          <button type='button' class='btn btn-primary' data-opens='new-user'>
            New user
          </button>
        </div>
        <div class='table-box'>
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th class='right'>Active tokens</th>
                <th>Created</th>
                <th>
                  <span class='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colspan={4} class='empty'>
                    Add a user so they can sign in to your apps.
                  </td>
                </tr>
              ) : null}
              {users.map((user) => (
                <tr>
                  <td style='font-weight: 500'>{user.username}</td>
                  <td class={user.token_count === 0 ? 'right muted' : 'right'}>
                    {formatCount(user.token_count)}
                  </td>
                  <td class='muted'>{formatDate(user.created_at)}</td>
                  <td class='actions'>
                    <button type='button' class='btn btn-small' data-opens={`reset-${user.id}`}>
                      Reset password
                    </button>
                    <button
                      type='button'
                      class='btn btn-small btn-danger'
                      data-opens={`delete-${user.id}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <Dialog
        id='new-user'
        title='New user'
        action='/admin/users'
        submitLabel='Create user'
        open={dialog?.id === 'new-user'}
      >
        <Field
          id='username'
          label='Username'
          value={dialog?.username}
          autocomplete='off'
          error={dialog?.id === 'new-user' ? dialog.error : undefined}
        />
        <Field
          id='password'
          label='Password'
          type='password'
          autocomplete='new-password'
          help='Use at least 8 characters, then pass it on to them yourself.'
        />
      </Dialog>
      {users.map((user) => (
        <>
          <Dialog
            id={`reset-${user.id}`}
            title={`Reset password for ${user.username}`}
            description='Their signed-in devices keep working until they sign out.'
            action={`/admin/users/${user.id}/password`}
            submitLabel='Reset password'
            open={dialog?.id === `reset-${user.id}`}
          >
            <Field
              id={`password-${user.id}`}
              name='password'
              label='New password'
              type='password'
              autocomplete='new-password'
              help='Use at least 8 characters.'
              error={dialog?.id === `reset-${user.id}` ? dialog.error : undefined}
            />
          </Dialog>
          <Dialog
            id={`delete-${user.id}`}
            title={`Delete ${user.username}?`}
            description={`This signs out all ${formatCount(user.token_count)} of their devices. Anything they synced stays in the apps.`}
            action={`/admin/users/${user.id}/delete`}
            submitLabel='Delete user'
            submitClass='btn-danger-filled'
          />
        </>
      ))}
    </AdminShell>
  );
}
