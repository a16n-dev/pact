import type { PropsWithChildren } from 'hono/jsx';
import { Document } from '../../ui/Document';
import type { AppRow } from '../../db/apps';
import { HardDrive, type IconNode, KeyRound, LayoutGrid, Settings, Users } from 'lucide';
import { Icon } from '../../ui/Icon';

type AdminSection = 'apps' | 'users';
export type AppTab = 'blobs' | 'tokens' | 'settings';

type AdminShellProps = PropsWithChildren<{
  title: string;
  section: AdminSection;
  app?: { row: AppRow; tab: AppTab };
  narrow?: boolean;
}>;

const APP_TABS: { id: AppTab; label: string; icon: IconNode }[] = [
  { id: 'blobs', label: 'Blobs', icon: HardDrive },
  { id: 'tokens', label: 'Tokens', icon: KeyRound },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function AdminShell({ title, section, app, narrow, children }: AdminShellProps) {
  return (
    <Document title={`${title} · pact admin`} withScript bodyClass='frame'>
      <header class='topbar'>
        <a href='/admin' class='wordmark'>
          pact
        </a>
      </header>
      <aside class='sidebar'>
        <nav aria-label='Admin' class='side-nav'>
          <a href='/admin/apps' aria-current={section === 'apps' && !app ? 'page' : undefined}>
            <Icon icon={LayoutGrid} size={16} />
            Apps
          </a>
          <a href='/admin/users' aria-current={section === 'users' ? 'page' : undefined}>
            <Icon icon={Users} size={16} />
            Users
          </a>
        </nav>
        {app ? (
          <nav aria-label={app.row.name} class='side-nav'>
            <div class='side-title'>{app.row.name}</div>
            {APP_TABS.map((entry) => (
              <a
                href={`/admin/apps/${app.row.id}/${entry.id}`}
                aria-current={entry.id === app.tab ? 'page' : undefined}
              >
                <Icon icon={entry.icon} size={16} />
                {entry.label}
              </a>
            ))}
          </nav>
        ) : null}
      </aside>
      <main class={narrow ? 'content content-narrow' : 'content'}>{children}</main>
    </Document>
  );
}
