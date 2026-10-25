import { requireSuperAdmin } from '@/lib/superadmin';
import { TopNav } from '@/components/shell/top-nav';
import { SearchBox } from '@/components/shell/search-box';
import { SettingsLink } from '@/components/shell/settings-link';
import { SignOutButton } from '@/components/sign-out-button';
import { Logo } from '@/components/shell/logo';

/**
 * The admin shell. Deliberately NOT the (app) shell: there is no active organization here, so the drive chips and
 * the drive menu would be showing a tenant context these pages do not have. Since C6 (spec §1.1, Ruling 1) it
 * carries the app's own Main nav (TopNav, with Admin current on every /admin page), the gear and Sign out; the five
 * admin sections are the in-page tabs under each heading (AdminSections).
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
    <>
      {/* The bottom padding is the room the fixed mobile nav bar occupies (see
          the wrapper below). It lives here, once, rather than on each admin
          page, which would otherwise each have to remember it. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {/* Below sm the header wraps: wordmark on line one, then the search
            box, the operator's email, the gear and Sign out. They do not fit on one
            line at 390px, and nowrap would push the last of them off-screen. */}
        <header
          data-testid="admin-header"
          className="relative flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:h-[72px] sm:flex-nowrap sm:gap-4 sm:px-7 sm:py-0"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}
        >
          <span
            className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[18px] font-bold tracking-[-0.02em]"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}
          >
            <Logo size={24} />
            <span>webfloppy <span style={{ color: 'var(--muted)' }}>admin</span></span>
          </span>
          {/* In flow from sm, centred in the space between the wordmark and
              the right-hand group, and absolutely centred on the bar only
              from 2xl, where that measures clear of the search box (Phase B
              final review F1: centred from sm, the pill ran ~40px under the
              search box at 1280, and clicks on its hidden part went to the
              input). The app shell does the same from xl; this bar's right
              group is wider, so it waits until 2xl. Below sm the same wrapper
              becomes a fixed bottom bar instead of a strip painted over the
              wordmark (spec D-6-2). e2e/header-overlap.spec.ts pins it. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's rather than
            // its TOP edge lining up with the search box's top -- the pill is
            // 42px tall (34 + its own 4px padding), so aligning tops left it
            // sitting 4px high. From 2xl, pointer-events-none on the
            // full-width wrapper, auto on the pill: there the wrapper spans
            // the header and would otherwise swallow clicks meant for the
            // search box behind it. In flow (sm to 2xl) it covers nothing.
            //
            // 2xl:top-[19px] is (72 - 34) / 2: the 72px bar's middle. Below sm
            // the bar's look comes from --nav-scrim / --nav-scrim-hairline, a
            // light surface now like the header itself.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md sm:static sm:z-auto sm:min-w-0 sm:flex-1 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none 2xl:pointer-events-none 2xl:absolute 2xl:inset-x-0 2xl:top-[19px] 2xl:bottom-auto 2xl:h-[34px]"
          >
            {/* The pill scrolls inside this clamp, at every width where the
                space left for it is short (the phone bar, and the in-flow bar
                at narrow sm widths), rather than the bar scrolling around it
                -- a justify-center scroll container puts the start of its own
                content out of reach once it overflows. */}
            <div className="pointer-events-auto max-w-full overflow-x-auto">
              {/* Every page under this layout passed requireSuperAdmin(), so Admin is shown (TopNav's own rule). */}
              <TopNav showAdmin />
            </div>
          </div>
          {/* Wraps onto its own full-width line below sm; ml-auto is inert
              there and still does the work at sm and up. */}
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:gap-4">
            <SearchBox />
            {/* Hidden from sm until xl: with it, the bar has no room for the
                pill between the wordmark and the search box (the pill would
                scroll inside a 0px clamp at 640 and the bar overflowed the
                viewport). It is a label, not a control; below sm it has its
                own wrapped line again. */}
            <span
              className="hidden max-w-[180px] truncate font-mono text-[11.5px] xl:block"
              style={{ color: 'var(--muted)' }}
              data-testid="admin-email"
            >
              {email}
            </span>
            <SettingsLink />
            <SignOutButton />
          </div>
        </header>
        {children}
      </div>
    </>
  );
}
