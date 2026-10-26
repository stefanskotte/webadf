import { nowMs } from '@/lib/clock';
import { requireOrg } from "@/lib/session";
import { isSuperAdminEmail } from "@/lib/superadmin";
import { getDb } from "@/db";
import { liveFingerprint, liveStateRows } from "@/lib/live-state";
import { latestReleaseSequence } from "@/lib/firmware-releases";
import { TopNav } from "@/components/shell/top-nav";
import { SearchBox } from "@/components/shell/search-box";
import { SignOutButton } from "@/components/sign-out-button";
import { SettingsLink } from "@/components/shell/settings-link";
import { Logo } from "@/components/shell/logo";
import { Link } from "@/components/shell/link";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { DriveChips } from "@/components/shell/drive-chips";
import { HeaderStart } from "@/components/shell/header-start";
import { driveChips } from "@/lib/drive-chips";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { email, orgId } = await requireOrg();
  // Decided here, on the server, and passed down as a plain boolean -- the
  // allowlist itself never reaches the client.
  const showAdmin = isSuperAdminEmail(email);
  // Computed with the SAME functions /api/live-state uses, so LiveRefresh's
  // baseline is exactly what this render already reflects -- not "whatever
  // the client's first fetch happens to see". A change landing between this
  // render and that first fetch would otherwise be silently absorbed into
  // the baseline and never shown (see LiveRefresh's doc comment).
  // Both inputs, and the SAME ones /api/live-state hashes -- a baseline that
  // disagrees with the poll makes every idle tab refresh forever.
  const [liveRows, latestRelease] = await Promise.all([
    liveStateRows(getDb(), orgId),
    latestReleaseSequence(orgId),
  ]);
  // ONE clock reading for both: the chips and the fingerprint must describe
  // the same instant, or a board crossing the online threshold between two
  // Date.now() calls would render one way and fingerprint as the other.
  const now = nowMs();
  const fingerprint = liveFingerprint(liveRows, now, latestRelease);
  // The header's drive chips, from the SAME rows -- no query of their own on
  // every page, and every field they show is in the fingerprint above, so
  // LiveRefresh keeps them exactly as fresh as the Devices page.
  const chips = driveChips(liveRows, now);
  return (
    <>
      <LiveRefresh initial={fingerprint} />
      {/* The bottom padding is the room the fixed tab bar occupies below lg (see the wrapper below). It lives here,
          once, rather than on each page: every page under this layout is behind that bar, and a page that forgot the
          padding would hide its own last row under it. 4.5rem >= the bar's 6 + 52 + 8 px. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* Below lg one 60 px row (C7 spec §2.2, Rulings 1-3): home, the drive chip filling the middle, search. The
            gear, Sign out and the (i) are in the bar's More menu there. From lg this is today's 72 px bar. */}
        <header
          data-testid="app-header"
          className="relative flex h-[60px] items-center gap-2.5 border-b px-4 lg:h-[72px] lg:gap-4 lg:px-7"
          style={{ background: "var(--surface)", borderColor: "var(--line)" }}
        >
          {/* The wordmark and, after it, a lane that centres the drive chips
              between the wordmark and the pill -- see HeaderStart for the
              geometry (from xl). Below lg the lane is a plain flex row whose
              chip slot fills the middle. */}
          <HeaderStart pillEstimate={showAdmin ? 394 : 317}>
            {/* The wordmark is the way home (operator, 2026-09-21). 44 x 44 at
                least for a finger; the word shows from sm and is sr-only below
                it, so the link keeps its name. */}
            <Link
              href="/library"
              data-testid="wordmark-home"
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2.5 text-[18px] font-bold tracking-[-0.02em] sm:justify-start"
              style={{ color: "var(--ink)", fontFamily: "var(--font-display)" }}
            >
              <Logo size={24} />
              <span className="max-sm:sr-only">webfloppy</span>
            </Link>
            {/* The chip slot: below lg it fills the row (the compact Drives
                control is full width, 44 px); from lg HeaderStart centres the
                chips beside the wordmark as before. No board: empty space. */}
            <div className="flex min-w-0 flex-1 items-center lg:justify-center">
              <DriveChips chips={chips} showAdmin={showAdmin} />
            </div>
          </HeaderStart>
        {/* The nav is centred on the VIEWPORT from xl, which means taking it
            out of flow (mx-auto and a 1fr/auto/1fr grid were both tried and
            measured first; see git history). Between lg and xl it is in flow,
            flex-1, and the pill scrolls inside its clamp when space is short
            (Phase B final review F1: centred, it ran under the search box).

            Below lg the same wrapper is the fixed bottom tab bar (C7 spec §2.3,
            Ruling 1): with a board the header pill showed 0 px of 317 at
            640-700 and was clipped up to 1000; from 1024 it fits in every case.
            Moved by CSS, never duplicated -- a second, phone copy of the nav
            would make getByRole('link') ambiguous under strict mode and fail
            the suite at 1280. e2e/header-overlap.spec.ts pins both. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's. From xl,
            // pointer-events-none on the full-width wrapper, auto on the pill:
            // there the wrapper spans the header and would otherwise swallow
            // clicks meant for the search box behind it.
            //
            // xl:top-[19px] is (72 - 34) / 2: the 72px bar's middle. Below lg
            // the bar's look comes from --nav-scrim / --nav-scrim-hairline.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-2 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:z-auto lg:min-w-0 lg:flex-1 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none xl:pointer-events-none xl:absolute xl:inset-x-0 xl:top-[19px] xl:bottom-auto xl:h-[34px]"
          >
            {/* data-nav-pill: what HeaderStart measures. Full width below lg,
                so the tab bar can take its 560 px. */}
            <div data-nav-pill className="pointer-events-auto max-w-full overflow-x-auto max-lg:w-full">
              <TopNav showAdmin={showAdmin} />
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <SearchBox />
            {/* From lg only: below it these are the More menu's (C7 spec §2.2). The (i) is gone at every width (Ruling 20). */}
            <span className="hidden items-center gap-2 lg:flex">
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
