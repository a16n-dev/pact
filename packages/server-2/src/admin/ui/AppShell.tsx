import type { Child, PropsWithChildren } from 'hono/jsx';
import { AdminShell, type Crumb } from './AdminShell';
import type { AppRow } from '../../db/apps';

export type AppTab = 'documents' | 'blobs' | 'access' | 'settings';

type AppShellProps = PropsWithChildren<{
  app: AppRow;
  tab: AppTab;
  actions?: Child;
  narrow?: boolean;
  trail?: Crumb[];
}>;

const TABS: { id: AppTab; label: string }[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'blobs', label: 'Blobs' },
  { id: 'access', label: 'Access' },
  { id: 'settings', label: 'Settings' },
];

export function AppShell({ app, tab, actions, narrow, trail = [], children }: AppShellProps) {
  const current = TABS.find((entry) => entry.id === tab)!;
  return (
    <AdminShell
      title={`${trail.at(-1)?.label ?? current.label} · ${app.name}`}
      section='apps'
      crumbs={[
        { label: 'Apps', href: '/admin/apps' },
        { label: app.name, href: trail.length > 0 ? `/admin/apps/${app.id}/${tab}` : undefined },
        ...trail,
      ]}
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
