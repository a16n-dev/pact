import type { PropsWithChildren } from 'hono/jsx';
import { Document } from '../../ui/Document';

type AdminSection = 'apps' | 'users';

type AdminShellProps = PropsWithChildren<{ title: string; host: string; section: AdminSection }>;

export function AdminShell({ title, host, section, children }: AdminShellProps) {
  return (
    <Document title={`${title} · pact admin`} withScript>
      <header class='topbar'>
        <div class='row' style='gap: 10px; align-items: baseline'>
          <a href='/admin' class='wordmark'>
            pact
          </a>
          <span class='host'>{host}</span>
        </div>
        <nav aria-label='Admin'>
          <a href='/admin/apps' aria-current={section === 'apps' ? 'page' : undefined}>
            Apps
          </a>
          <a href='/admin/users' aria-current={section === 'users' ? 'page' : undefined}>
            Users
          </a>
        </nav>
        <span class='access'>Cloudflare Access</span>
      </header>
      {children}
    </Document>
  );
}
