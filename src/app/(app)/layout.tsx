import { requireOrg } from "@/lib/session";
import { isSuperAdminEmail } from "@/lib/superadmin";
import { TopNav } from "@/components/shell/top-nav";
import { SearchBox } from "@/components/shell/search-box";
import { SignOutButton } from "@/components/sign-out-button";
import { Logo } from "@/components/shell/logo";
import { NavProgressProvider } from "@/components/shell/nav-progress";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { email } = await requireOrg();
  // Decided here, on the server, and passed down as a plain boolean -- the
  // allowlist itself never reaches the client.
  const showAdmin = isSuperAdminEmail(email);
  return (
    <NavProgressProvider>
      <div className="min-h-screen">
        <header className="relative flex items-center gap-4 px-7 pt-4">
          <span
            className="flex items-center gap-2.5 text-base font-bold tracking-[-0.02em]"
            style={{ color: "var(--on-dark)" }}
          >
            <Logo size={22} />
            webadf
          </span>
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
            needs. Narrow viewports will overlap; that is the responsive
            pass's problem, not this one's. */}
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
              <TopNav showAdmin={showAdmin} />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <SearchBox />
            <SignOutButton />
          </div>
        </header>
        {children}
      </div>
    </NavProgressProvider>
  );
}
