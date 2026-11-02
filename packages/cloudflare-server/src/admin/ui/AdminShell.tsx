import type { PropsWithChildren } from 'hono/jsx';
import { Document } from '../../ui/Document';
import { ChevronRight, LayoutGrid, Users } from 'lucide';
import { Icon } from '../../ui/Icon';

type AdminSection = 'apps' | 'users';
export type Crumb = { label: string; href?: string };

type AdminShellProps = PropsWithChildren<{
  title: string;
  section: AdminSection;
  crumbs?: Crumb[];
  narrow?: boolean;
}>;

export function AdminShell({ title, section, crumbs, narrow, children }: AdminShellProps) {
  return (
    <Document title={`${title} · Pact admin`} withScript bodyClass='frame'>
      <header class='topbar'>
        <a href='/admin' class='wordmark'>
          pact
        </a>
        {crumbs ? (
          <nav aria-label='Breadcrumb' class='breadcrumb'>
            {crumbs.map((crumb, i) => (
              <>
                {i > 0 ? <Icon icon={ChevronRight} size={14} /> : null}
                {crumb.href ? (
                  <a href={crumb.href}>{crumb.label}</a>
                ) : (
                  <span aria-current='page'>{crumb.label}</span>
                )}
              </>
            ))}
          </nav>
        ) : null}
      </header>
      <aside class='sidebar'>
        <nav aria-label='Admin' class='side-nav'>
          <a href='/admin/apps' aria-current={section === 'apps' ? 'page' : undefined}>
            <Icon icon={LayoutGrid} size={16} />
            Apps
          </a>
          <a href='/admin/users' aria-current={section === 'users' ? 'page' : undefined}>
            <Icon icon={Users} size={16} />
            Users
          </a>
        </nav>
      </aside>
      <main class={narrow ? 'content content-narrow' : 'content'}>{children}</main>
    </Document>
  );
}
