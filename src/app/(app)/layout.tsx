import { requireOrg } from "@/lib/session";
import { isSuperAdminEmail } from "@/lib/superadmin";
import { TopNav } from "@/components/shell/top-nav";
import { SearchBox } from "@/components/shell/search-box";
import { SignOutButton } from "@/components/sign-out-button";
import { Logo } from "@/components/shell/logo";

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
    <div className="min-h-screen">
      <header className="flex items-center gap-4 px-7 pt-4">
        <span
          className="flex items-center gap-2.5 text-base font-bold tracking-[-0.02em]"
          style={{ color: "var(--on-dark)" }}
        >
          <Logo size={22} />
          webadf
        </span>
        <TopNav showAdmin={showAdmin} />
        <SearchBox />
        <SignOutButton />
      </header>
      {children}
    </div>
  );
}
