import { Document } from '../ui/Document';
import { WarningIcon } from '../ui/icons';

export type AuthErrorPageProps = {
  title: string;
  message: string;
  appId?: string;
  redirectUri?: string;
};

export function AuthErrorPage({ title, message, appId, redirectUri }: AuthErrorPageProps) {
  return (
    <Document title={`${title} · pact`} bodyClass='login'>
      <span class='wordmark' style='margin-bottom: 64px'>
        pact
      </span>
      <div class='icon-badge icon-badge-warning' style='margin-bottom: 20px'>
        <WarningIcon size={24} />
      </div>
      <h1 style='margin: 0 0 12px; font-size: 26px'>{title}</h1>
      <p class='muted' style='margin-bottom: 28px'>
        {message}
      </p>
      {appId || redirectUri ? (
        <dl class='details'>
          {appId ? (
            <div>
              <dt>App ID</dt>
              <dd>{appId}</dd>
            </div>
          ) : null}
          {redirectUri ? (
            <div>
              <dt>Return address</dt>
              <dd>{redirectUri}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <p class='footer'>You can close this window.</p>
    </Document>
  );
}
