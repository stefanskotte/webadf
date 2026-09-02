import { Link } from '@/components/shell/link';
import { requireSuperAdmin } from '@/lib/superadmin';
import { AdminNav } from '@/components/admin/admin-nav';
import { SearchBox } from '@/components/shell/search-box';
import { Logo } from '@/components/shell/logo';
import { NavProgressProvider } from '@/components/shell/nav-progress';

/**
 * The admin shell. Deliberately NOT the (app) shell: there is no active
 * organization here, so the org switcher and the library/devices/ingest nav
 * would all be showing a tenant context these pages do not have.
 *
 * requireSuperAdmin() is called here and *also* independently by every
 * /api/admin route. A layout guard is not an API guard -- a page render and a
 * later fetch are separate requests, and only the second is what an attacker
 * sends.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { email } = await requireSuperAdmin();
  return (
    <NavProgressProvider>
      <div className="min-h-screen">
        <header className="relative flex items-center gap-4 px-7 pt-4">
          <span
            className="flex items-center gap-2.5 text-base font-bold tracking-[-0.02em]"
            style={{ color: 'var(--on-dark)' }}
          >
            <Logo size={22} />
            <span>webadf <span style={{ color: 'var(--on-dark-muted)' }}>admin</span></span>
          </span>
          {/* Absolutely centred, matching the app shell exactly -- see its
              comment for the two weaker versions that were measured first. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's rather than
            // its TOP edge lining up with the search box's top -- the pill is
            // 42px tall (34 + its own 4px padding), so aligning tops left it
            // sitting 4px high. pointer-events-none on the full-width wrapper,
            // auto on the pill: the wrapper spans the header and would
            // otherwise swallow clicks meant for the search box behind it.
            className="pointer-events-none absolute inset-x-0 top-4 flex h-[34px] items-center justify-center"
          >
            <div className="pointer-events-auto">
              <AdminNav />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <SearchBox />
            <span
              className="max-w-[180px] truncate font-mono text-[11.5px]"
              style={{ color: 'var(--on-dark-muted)' }}
              data-testid="admin-email"
            >
              {email}
            </span>
            {/* The way back to the ordinary app; the admin shell has no TopNav. */}
            <Link
              href="/library"
              className="whitespace-nowrap text-[13px] font-medium"
              style={{ color: 'rgb(233 240 244 / 0.78)' }}
            >
              Back to library
            </Link>
          </div>
        </header>
        {children}
      </div>
    </NavProgressProvider>
  );
}
