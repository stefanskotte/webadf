import { requireOrg } from "@/lib/session";
import { TopNav } from "@/components/shell/top-nav";
import { SignOutButton } from "@/components/sign-out-button";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOrg();
  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 px-7 pt-4">
        <span
          className="text-base font-bold tracking-[-0.02em]"
          style={{ color: "var(--on-dark)" }}
        >
          webadf
        </span>
        <TopNav />
        <SignOutButton />
      </header>
      {children}
    </div>
  );
}
