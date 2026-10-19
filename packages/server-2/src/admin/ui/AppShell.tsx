import type { Child, PropsWithChildren } from 'hono/jsx';
import { AdminShell } from './AdminShell';
import type { AppRow } from '../../db/apps';

export type AppTab = 'blobs' | 'tokens' | 'settings';

type AppShellProps = PropsWithChildren<{
  app: AppRow;
  tab: AppTab;
  actions?: Child;
  narrow?: boolean;
}>;

const TABS: { id: AppTab; label: string }[] = [
  { id: 'blobs', label: 'Blobs' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'settings', label: 'Settings' },
];

export function AppShell({ app, tab, actions, narrow, children }: AppShellProps) {
  const current = TABS.find((entry) => entry.id === tab)!;
  return (
    <AdminShell
      title={`${current.label} · ${app.name}`}
      section='apps'
      crumbs={[{ label: 'Apps', href: '/admin/apps' }, { label: app.name }]}
      narrow={narrow}
    >
      <div class='toolbar'>
        <nav aria-label='App' class='segmented'>
          {TABS.map((entry) => (
            <a
              href={`/admin/apps/${app.id}/${entry.id}`}
              aria-current={entry.id === tab ? 'page' : undefined}
            >
              {entry.label}
            </a>
          ))}
        </nav>
        {actions ? <div class='row'>{actions}</div> : null}
      </div>
      {children}
    </AdminShell>
  );
}
