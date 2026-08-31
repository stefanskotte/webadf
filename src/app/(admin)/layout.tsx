import Link from 'next/link';
import { requireSuperAdmin } from '@/lib/superadmin';
import { AdminNav } from '@/components/admin/admin-nav';

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
    <div className="min-h-screen">
      <header className="flex items-center gap-4 px-7 pt-4">
        <span
          className="text-base font-bold tracking-[-0.02em]"
          style={{ color: 'var(--on-dark)' }}
        >
          webadf <span style={{ color: 'var(--on-dark-muted)' }}>admin</span>
        </span>
        <AdminNav />
        <div className="ml-auto flex items-center gap-4">
          <span
            className="font-mono text-[11.5px]"
            style={{ color: 'var(--on-dark-muted)' }}
            data-testid="admin-email"
          >
            {email}
          </span>
          {/* The way back to the ordinary app; the admin shell has no TopNav. */}
          <Link
            href="/library"
            className="text-[13px] font-medium"
            style={{ color: 'rgb(233 240 244 / 0.78)' }}
          >
            Back to library
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
