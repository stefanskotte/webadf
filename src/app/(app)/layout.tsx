import { requireOrg } from "@/lib/session";
import { isSuperAdminEmail } from "@/lib/superadmin";
import { getDb } from "@/db";
import { liveFingerprint, liveStateRows } from "@/lib/live-state";
import { latestReleaseSequence } from "@/lib/firmware-releases";
import { TopNav } from "@/components/shell/top-nav";
import { SearchBox } from "@/components/shell/search-box";
import { SignOutButton } from "@/components/sign-out-button";
import { Logo } from "@/components/shell/logo";
import { Link } from "@/components/shell/link";
import { NavProgressProvider } from "@/components/shell/nav-progress";
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
    latestReleaseSequence(),
  ]);
  // ONE clock reading for both: the chips and the fingerprint must describe
  // the same instant, or a board crossing the online threshold between two
  // Date.now() calls would render one way and fingerprint as the other.
  const now = Date.now();
  const fingerprint = liveFingerprint(liveRows, now, latestRelease);
  // The header's drive chips, from the SAME rows -- no query of their own on
  // every page, and every field they show is in the fingerprint above, so
  // LiveRefresh keeps them exactly as fresh as the Devices page.
  const chips = driveChips(liveRows, now);
  return (
    <NavProgressProvider>
      <LiveRefresh initial={fingerprint} />
      {/* The bottom padding is the room the fixed mobile nav bar occupies (see
          the wrapper below). It lives here, once, rather than on each page:
          every page under this layout is behind that bar, and a page that
          forgot the padding would hide its own last row under it. */}
      <div className="min-h-screen pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {/* Below sm the header wraps: the wordmark keeps line one and the
            search box plus sign-out take line two full-width. At 390px they do
            not fit on one line, and nowrap would push the sign-out button off
            the right edge rather than shrinking anything. */}
        <header className="relative flex flex-wrap items-center gap-3 px-4 pt-4 sm:flex-nowrap sm:gap-4 sm:px-7">
          {/* The wordmark and, after it, a lane that centres the drive chips
              between the wordmark and the pill -- see HeaderStart for the
              geometry. The estimate is only the first paint's; the pill is
              measured on the client. */}
          <HeaderStart pillEstimate={showAdmin ? 322 : 248}>
            {/* The wordmark is the way home. Every other shell in the app has an
                explicit way back to the library; this one only had the nav pill,
                and the mark is where people click first (operator, 2026-09-21).
                Uses the shell's own Link, so it drives the navigation bar like
                every other in-app link. */}
            <Link
              href="/library"
              data-testid="wordmark-home"
              className="flex items-center gap-2.5 text-base font-bold tracking-[-0.02em]"
              style={{ color: "var(--on-dark)" }}
            >
              <Logo size={22} />
              webadf
            </Link>
            {/* Beside the wordmark, in flow, rather than beside the pill: the
                pill is absolutely centred (below), so anything placed next to
                it would have to be absolute too, and would run into the search
                box on the right. Here the chips take real width and the pill's
                own centring is untouched. Full chips only from xl; see
                DriveChips for the compact control used below that. The lane
                centres them from sm up (HeaderStart); below sm the compact
                control's own ml-auto still puts it at the line's right end. */}
            <div className="flex flex-1 items-center sm:justify-center">
              <DriveChips chips={chips} />
            </div>
          </HeaderStart>
        {/* The nav is centred on the VIEWPORT, which means taking it out of
            flow. Two weaker versions were tried and measured first: mx-auto
            only centres within the space its siblings leave over, so the
            wider right-hand group pushed the pill left (and by a different
            amount in each shell, which is what made the two look misaligned
            when moving between them); and a 1fr/auto/1fr grid centred it
            exactly but forced both sides into equal columns, which is less
            room than the right side needs -- "Back to library" wrapped onto
            two lines. Absolute centring is the only one of the three that
            centres the pill AND lets each side take the width it actually
            needs. Narrow viewports overlap, and below sm that overlap is the
            whole problem: at 390px the pill lands on top of the wordmark and
            the search box, with the click going to whichever paints last. So
            below sm this same wrapper stops being a centred strip and becomes
            a fixed bottom bar, where a thumb is (spec D-6-2). Moved by CSS,
            never duplicated -- a second, mobile copy of the nav would make
            getByRole('link') ambiguous under strict mode and fail the suite
            at 1280. */}
          <div
            // h-[34px] matching the flow content's height, with items-center,
            // so the pill's centre lines up with the search box's rather than
            // its TOP edge lining up with the search box's top -- the pill is
            // 42px tall (34 + its own 4px padding), so aligning tops left it
            // sitting 4px high. pointer-events-none on the full-width wrapper,
            // auto on the pill: the wrapper spans the header and would
            // otherwise swallow clicks meant for the search box behind it.
            // The bar takes the clicks back below sm, where it is opaque
            // enough to look like a surface and nothing sits behind it.
            //
            // The scrim is dark, not one of the white --glass-* surfaces:
            // the pill's text is the light --on-dark ramp, tuned against the
            // gradient's dark TOP band, and the bottom of the viewport is
            // where the gradient has reached its pale end. Glass there would
            // leave the nav labels at roughly 1.5:1.
            className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex items-center justify-center border-t border-(--nav-scrim-hairline) bg-(--nav-scrim) px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-md sm:pointer-events-none sm:absolute sm:top-4 sm:bottom-auto sm:z-auto sm:h-[34px] sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none"
          >
            {/* The pill scrolls inside this clamp rather than the bar
                scrolling around it: a justify-center scroll container puts
                the start of its own content out of reach once it overflows,
                which with four items is a 320px-wide phone away. */}
            {/* data-nav-pill: what HeaderStart measures. */}
            <div data-nav-pill className="pointer-events-auto max-w-full overflow-x-auto sm:max-w-none sm:overflow-visible">
              <TopNav showAdmin={showAdmin} />
            </div>
          </div>
          {/* Full-width on its own wrapped line below sm, so the search box
              has somewhere to grow into; ml-auto is inert at that width. */}
          <div className="ml-auto flex w-full items-center gap-4 sm:w-auto">
            <SearchBox />
            <SignOutButton />
          </div>
        </header>
        {children}
      </div>
    </NavProgressProvider>
  );
}
