import type { PropsWithChildren } from 'hono/jsx';
import { Boxes, ChevronRight, ShieldCheck, Users } from 'lucide';
import { Document } from '../../ui/Document';
import { Icon } from '../../ui/Icon';

type AdminSection = 'apps' | 'users';

export type Crumb = { label: string; href?: string };

type AdminShellProps = PropsWithChildren<{
  title: string;
  host: string;
  section: AdminSection;
  crumbs?: Crumb[];
}>;

const SECTIONS = [
  { id: 'apps', label: 'Apps', icon: Boxes },
  { id: 'users', label: 'Users', icon: Users },
] as const;

export function AdminShell({ title, host, section, crumbs, children }: AdminShellProps) {
  const trail = crumbs ?? [{ label: SECTIONS.find((entry) => entry.id === section)!.label }];
  return (
    <Document title={`${title} · pact admin`} withScript>
      <div class='shell'>
        <aside class='sidebar'>
          <a href='/admin' class='brand'>
            <span class='wordmark'>pact</span>
            <span class='host'>{host}</span>
          </a>
          <nav aria-label='Admin'>
            {SECTIONS.map((entry) => (
              <a
                href={`/admin/${entry.id}`}
                aria-current={entry.id === section ? 'page' : undefined}
              >
                <Icon icon={entry.icon} size={18} />
                {entry.label}
              </a>
            ))}
          </nav>
          <div class='sidebar-foot'>
            <Icon icon={ShieldCheck} size={16} />
            Cloudflare Access
          </div>
        </aside>
        <div class='content'>
          <header class='topbar'>
            <nav aria-label='Breadcrumb' class='breadcrumb'>
              {trail.map((crumb, i) => (
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
          </header>
          {children}
        </div>
      </div>
    </Document>
  );
}
