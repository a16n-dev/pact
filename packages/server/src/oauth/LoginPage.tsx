import { Document } from '../ui/Document';
import { CircleAlert } from 'lucide';
import { Icon } from '../ui/Icon';

export type LoginPageProps = {
  host: string;
  turnstileSiteKey: string;
  continueAs?: string;
  username?: string;
  error?: string;
};

export function LoginPage({ host, turnstileSiteKey, continueAs, username, error }: LoginPageProps) {
  return (
    <Document title='Sign in · pact' bodyClass='login'>
      <div class='stack'>
        <span class='wordmark'>pact</span>
        <h1>Sign in to sync</h1>
        <p class='muted'>
          {continueAs ? (
            <>
              You're signed in to <code>{host}</code> as <strong>{continueAs}</strong>.
            </>
          ) : (
            <>
              Use the account your server admin gave you for <code>{host}</code>.
            </>
          )}
        </p>
      </div>
      <div style='height: 40px' />
      {error ? (
        <div role='alert' class='alert alert-error' style='margin-bottom: 20px'>
          <Icon icon={CircleAlert} color='var(--hz-red)' />
          <span>{error}</span>
        </div>
      ) : null}
      {continueAs ? (
        <form method='post'>
          <button type='submit' name='intent' value='continue' class='btn btn-primary btn-block'>
            Continue as {continueAs}
          </button>
          <button type='submit' name='intent' value='switch' class='btn btn-ghost btn-block'>
            Use a different account
          </button>
        </form>
      ) : (
        <form method='post'>
          <div class='field'>
            <label for='username'>Username</label>
            <input
              id='username'
              name='username'
              type='text'
              autocomplete='username'
              autocapitalize='none'
              required
              value={username ?? ''}
            />
          </div>
          <div class='field'>
            <label for='password'>Password</label>
            <input
              id='password'
              name='password'
              type='password'
              autocomplete='current-password'
              required
            />
          </div>
          <div class='cf-turnstile turnstile' data-sitekey={turnstileSiteKey} data-theme='dark' />
          <button type='submit' class='btn btn-primary btn-block'>
            Sign in
          </button>
        </form>
      )}
      <p class='footer'>Need an account? Ask the person who runs this server.</p>
      {continueAs ? null : (
        <script src='https://challenges.cloudflare.com/turnstile/v0/api.js' async defer />
      )}
    </Document>
  );
}
