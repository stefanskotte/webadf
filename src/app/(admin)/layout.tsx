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
      {/* The bottom padding is the room the fixed mobile nav bar occupies (see
          the wrapper below). It lives here, once, rather than on each admin
          page, which would otherwise each have to remember it. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {/* Below sm the header wraps: wordmark on line one, then the search
            box, the operator's email and the way back. They do not fit on one
            line at 390px, and nowrap would push the last of them off-screen. */}
        <header className="relative flex flex-wrap items-center gap-3 px-4 pt-4 sm:flex-nowrap sm:gap-4 sm:px-7">
          <span
            className="flex items-center gap-2.5 text-base font-bold tracking-[-0.02em]"
            style={{ color: 'var(--on-dark)' }}
          >
            <Logo size={22} />
            <span>webadf <span style={{ color: 'var(--on-dark-muted)' }}>admin</span></span>
          </span>
          {/* Absolutely centred, matching the app shell exactly -- see its
              comment for the two weaker versions that were measured first,
              and for why below sm the same wrapper becomes a fixed bottom bar
              instead of a strip painted over the wordmark (spec D-6-2). The
              two shells must agree here: the pill is the one thing that stays
              put while moving between them. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's rather than
            // its TOP edge lining up with the search box's top -- the pill is
            // 42px tall (34 + its own 4px padding), so aligning tops left it
            // sitting 4px high. pointer-events-none on the full-width wrapper,
            // auto on the pill: the wrapper spans the header and would
            // otherwise swallow clicks meant for the search box behind it.
            // The bar takes the clicks back below sm, where it is a surface
            // in its own right with nothing behind it.
            //
            // The scrim is dark, not one of the white --glass-* surfaces:
            // the pill's text is the light --on-dark ramp, tuned against the
            // gradient's dark TOP band, and the bottom of the viewport is
            // where the gradient has reached its pale end.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md sm:pointer-events-none sm:absolute sm:top-4 sm:bottom-auto sm:z-auto sm:h-[34px] sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none"
          >
            {/* Four items here at every width, so the pill scrolls inside
                this clamp rather than the bar scrolling around it -- a
                justify-center scroll container puts the start of its own
                content out of reach once it overflows. */}
            <div className="pointer-events-auto max-w-full overflow-x-auto sm:max-w-none sm:overflow-visible">
              <AdminNav />
            </div>
          </div>
          {/* Wraps onto its own full-width line below sm; ml-auto is inert
              there and still does the work at sm and up. */}
          <div className="ml-auto flex w-full flex-wrap items-center gap-3 sm:w-auto sm:flex-nowrap sm:gap-4">
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
