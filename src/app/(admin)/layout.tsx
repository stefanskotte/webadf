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
      {/* The bottom padding is the room the fixed tab bar occupies below lg. It
          lives here, once, rather than on each admin page. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* Below lg one 60 px row (C7 spec §2.2, §11.1, Ruling 8): the logo and
            "admin", then search. The gear and Sign out are in the bar's More
            menu there, where Admin is current. */}
        <header
          data-testid="admin-header"
          className="relative flex h-[60px] items-center gap-2.5 border-b px-4 lg:h-[72px] lg:gap-4 lg:px-7"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}
        >
          <span
            className="flex min-h-11 shrink-0 items-center gap-2.5 whitespace-nowrap text-[18px] font-bold tracking-[-0.02em]"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}
          >
            <Logo size={24} />
            {/* "webfloppy" from sm; below it the logo and "admin" say where you are. */}
            <span><span className="max-sm:sr-only">webfloppy </span><span style={{ color: 'var(--muted)' }}>admin</span></span>
          </span>
          {/* In flow from lg, centred in the space between the wordmark and the
              right-hand group, and absolutely centred on the bar only from 2xl,
              where that measures clear of the search box (Phase B final review
              F1). This bar's right group is wider than the app's (the email),
              so it waits until 2xl. Below lg the same wrapper is the fixed
              bottom tab bar (C7 spec §2.3). e2e/header-overlap.spec.ts pins it. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's. From 2xl,
            // pointer-events-none on the full-width wrapper, auto on the pill.
            //
            // 2xl:top-[19px] is (72 - 34) / 2: the 72px bar's middle.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-2 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:z-auto lg:min-w-0 lg:flex-1 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none 2xl:pointer-events-none 2xl:absolute 2xl:inset-x-0 2xl:top-[19px] 2xl:bottom-auto 2xl:h-[34px]"
          >
            <div className="pointer-events-auto max-w-full overflow-x-auto max-lg:w-full">
              {/* Every page under this layout passed requireSuperAdmin(), so Admin is shown (TopNav's own rule). */}
              <TopNav showAdmin />
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 lg:gap-4">
            <SearchBox />
            {/* From xl only: a label, not a control; below lg the address is on Settings. */}
            <span
              className="hidden max-w-[180px] truncate font-mono text-[11.5px] xl:block"
              style={{ color: 'var(--muted)' }}
              data-testid="admin-email"
            >
              {email}
            </span>
            {/* From lg only: below it these are the More menu's. */}
            <span className="hidden items-center gap-4 lg:flex">
              <SettingsLink />
              <SignOutButton />
            </span>
          </div>
        </header>
        {children}
      </div>
    </>
  );
}
