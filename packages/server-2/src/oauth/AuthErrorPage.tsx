import { Document } from '../ui/Document';
import { TriangleAlert } from 'lucide';
import { Icon } from '../ui/Icon';

export type AuthErrorPageProps = {
  title: string;
  message: string;
  appId?: string;
  redirectUri?: string;
};

export function AuthErrorPage({ title, message, appId, redirectUri }: AuthErrorPageProps) {
  return (
    <Document title={`${title} · pact`} bodyClass='login' withScript>
      <span class='wordmark' style='margin-bottom: 64px'>
        pact
      </span>
      <div class='icon-badge' style='margin-bottom: 20px'>
        <Icon icon={TriangleAlert} size={22} />
      </div>
      <h1 style='margin-bottom: 12px'>{title}</h1>
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
      {/* A popup closes; a same-tab flow steps back to the app that opened it */}
      <button type='button' class='btn btn-primary btn-block' style='margin-top: 28px' data-back>
        Back to the app
      </button>
    </Document>
  );
}
