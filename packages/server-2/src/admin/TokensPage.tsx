import { AppShell } from './ui/AppShell';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import type { AppRow } from '../db/apps';
import type { ApiTokenSummary, DeviceTokenSummary } from '../db/tokens';
import { formatDate, formatRelative } from './format';
import { Code, Copy, TriangleAlert, User } from 'lucide';
import { Icon } from '../ui/Icon';

export type TokensPageProps = {
  host: string;
  app: AppRow;
  api: ApiTokenSummary[];
  devices: DeviceTokenSummary[];
  mint?: { open: boolean; label?: string; error?: string };
  minted?: { label: string; token: string };
};

export function TokensPage({ host, app, api, devices, mint, minted }: TokensPageProps) {
  const base = `/admin/apps/${app.id}/tokens`;
  return (
    <AppShell host={host} app={app} tab='tokens'>
      <section aria-labelledby='h-api'>
        <div class='row spread' style='align-items: flex-end'>
          <div class='section-head'>
            <div class='section-icon section-icon-purple' aria-hidden='true'>
              <Icon icon={Code} size={20} />
            </div>
            <div class='stack' style='gap: 4px'>
              <h2 id='h-api'>API tokens</h2>
              <p class='muted small'>
                For scripts and integrations that need access without a user account.
              </p>
            </div>
          </div>
          <button type='button' class='btn btn-primary' data-opens='mint'>
            Mint API token
          </button>
        </div>
        <div class='table-box table-box-purple'>
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
                <tr>
                  <td colspan={5} class='empty'>
                    Mint a token to let a script or integration use this app.
                  </td>
                </tr>
              ) : null}
              {api.map((token) => (
                <tr>
                  <td style='font-weight: 500'>{token.label}</td>
                  <td class='mono small muted'>{token.token_prefix}…</td>
                  <td class='muted'>{formatDate(token.created_at)}</td>
                  <td>{formatRelative(token.last_seen_at)}</td>
                  <td class='actions'>
                    <button
                      type='button'
                      class='btn btn-small btn-danger'
                      data-opens={`revoke-${token.id}`}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby='h-devices' style='margin-top: 16px'>
        <div class='section-head'>
          <div class='section-icon section-icon-blue' aria-hidden='true'>
            <Icon icon={User} size={20} />
          </div>
          <div class='stack' style='gap: 4px'>
            <h2 id='h-devices'>Signed-in devices</h2>
            <p class='muted small'>
              Signing a device out cuts off its access straight away, and anything it already synced
              stays.
            </p>
          </div>
        </div>
        <div class='table-box'>
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
                <tr>
                  <td colspan={5} class='empty'>
                    Devices appear here once someone signs in to this app.
                  </td>
                </tr>
              ) : null}
              {devices.map((token) => (
                <tr>
                  <td style='font-weight: 500'>{token.username}</td>
                  <td>{token.label}</td>
                  <td class='muted'>{formatDate(token.created_at)}</td>
                  <td>{formatRelative(token.last_seen_at)}</td>
                  <td class='actions'>
                    <button
                      type='button'
                      class='btn btn-small btn-danger'
                      data-opens={`revoke-${token.id}`}
                    >
                      Sign out
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog
        id='mint'
        title='Mint API token'
        description={`Gives a script or integration full read and write access to ${app.name}.`}
        action={base}
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
            <h2 style='font-size: 20px'>Here's your API token</h2>
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
            <div class='alert alert-warning'>
              <Icon icon={TriangleAlert} color='var(--hz-yellow)' />
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
          action={`${base}/${token.id}/revoke`}
          submitLabel='Revoke token'
          submitClass='btn-danger-filled'
        />
      ))}
      {devices.map((token) => (
        <Dialog
          id={`revoke-${token.id}`}
          title={`Sign out ${token.label}?`}
          description={`${token.username} will need to sign in again on this device. Anything it synced stays.`}
          action={`${base}/${token.id}/revoke`}
          submitLabel='Sign out device'
          submitClass='btn-danger-filled'
        />
      ))}
    </AppShell>
  );
}
