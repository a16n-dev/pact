import { Document } from '../ui/Document';
import { AlertCircleIcon } from '../ui/icons';

export type LoginPageProps = {
  host: string;
  turnstileSiteKey: string;
  username?: string;
  error?: string;
};

export function LoginPage({ host, turnstileSiteKey, username, error }: LoginPageProps) {
  return (
    <Document title='Sign in · pact' bodyClass='login'>
      <div class='stack'>
        <span class='wordmark'>pact</span>
        <h1>Sign in to sync</h1>
        <p class='muted'>
          Use the account your server admin gave you for <code>{host}</code>.
        </p>
      </div>
      <div style='height: 40px' />
      {error ? (
        <div role='alert' class='alert alert-error' style='margin-bottom: 20px'>
          <AlertCircleIcon />
          <span>{error}</span>
        </div>
      ) : null}
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
      <p class='footer'>Need an account? Ask the person who runs this server.</p>
      <script src='https://challenges.cloudflare.com/turnstile/v0/api.js' async defer />
    </Document>
  );
}
