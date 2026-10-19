import type { PropsWithChildren } from 'hono/jsx';
import { AdminShell, type AppTab } from './AdminShell';
import type { AppRow } from '../../db/apps';

type AppShellProps = PropsWithChildren<{ app: AppRow; tab: AppTab; narrow?: boolean }>;

export function AppShell({ app, tab, narrow, children }: AppShellProps) {
  return (
    <AdminShell title={app.name} section='apps' app={{ row: app, tab }} narrow={narrow}>
      {children}
    </AdminShell>
  );
}
