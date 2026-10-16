import type { PropsWithChildren } from 'hono/jsx';
import { AdminShell } from './AdminShell';
import type { AppRow } from '../../db/apps';

type AppTab = 'blobs' | 'tokens' | 'settings';

type AppShellProps = PropsWithChildren<{
  host: string;
  app: AppRow;
  tab: AppTab;
  narrow?: boolean;
}>;

const TABS: { id: AppTab; label: string }[] = [
  { id: 'blobs', label: 'Blobs' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'settings', label: 'Settings' },
];

export function AppShell({ host, app, tab, narrow, children }: AppShellProps) {
  return (
    <AdminShell title={app.name} host={host} section='apps'>
      <div class='app-header'>
        <div>
          <nav aria-label='Breadcrumb' class='breadcrumb'>
            <a href='/admin/apps'>Apps</a>
            <span class='sep'>/</span>
            <span class='muted'>{app.name}</span>
          </nav>
          <div class='row' style='gap: 6px 14px; align-items: baseline'>
            <h1>{app.name}</h1>
            <span class='mono muted'>{app.id}</span>
          </div>
          <nav aria-label='App' class='tabs'>
            {TABS.map((entry) => (
              <a
                href={`/admin/apps/${app.id}/${entry.id}`}
                aria-current={entry.id === tab ? 'page' : undefined}
              >
                {entry.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
      <main class={narrow ? 'container container-narrow' : 'container'}>{children}</main>
    </AdminShell>
  );
}
